//! Parallel repository walk.
//!
//! Deliberately mirrors the TypeScript walker it replaces — same ignore list,
//! same language table, same 16-character sha256 prefix — so the two can be
//! compared on the same repository and produce the same rows.

use ignore::WalkBuilder;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

const IGNORED_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
    "coverage", "__pycache__", ".venv", "venv", "env", ".mypy_cache", ".ruff_cache",
    ".pytest_cache", ".tox", "target", "vendor", "site-packages", ".eggs", "htmlcov",
    ".idea", ".vscode", "sdlc-audit", ".turbo", ".cache", ".parcel-cache",
];

pub struct Scanned {
    pub path: String,
    pub lang: &'static str,
    pub loc: u32,
    pub bytes: u32,
    pub content_sha: String,
    pub is_test: bool,
    pub content: String,
}

pub fn classify(path: &str) -> &'static str {
    let ext = match path.rfind('.') {
        Some(index) => path[index..].to_ascii_lowercase(),
        None => return "other",
    };
    match ext.as_str() {
        ".ts" | ".mts" | ".cts" | ".tsx" => "typescript",
        ".js" | ".mjs" | ".cjs" | ".jsx" => "javascript",
        ".py" | ".pyi" => "python",
        ".json" | ".yml" | ".yaml" | ".toml" | ".ini" => "config",
        ".md" | ".rst" => "docs",
        _ => "other",
    }
}

/// Mirrors the TypeScript regexes without pulling in a regex engine: these
/// are all anchored substring checks in disguise.
pub fn is_test_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    if segments
        .iter()
        .any(|part| matches!(*part, "test" | "tests" | "__tests__" | "spec" | "e2e"))
    {
        return true;
    }

    let file = *segments.last().unwrap_or(&"");

    // *.test.ts / *.spec.tsx / *.test.mjs …
    for marker in [".test.", ".spec."] {
        if let Some(index) = file.rfind(marker) {
            let suffix = &file[index + marker.len()..];
            if matches!(suffix, "ts" | "tsx" | "js" | "jsx" | "mts" | "mjs" | "cts" | "cjs") {
                return true;
            }
        }
    }

    file == "conftest.py" || file.ends_with("_test.py") || file.starts_with("test_") && file.ends_with(".py")
}

pub fn is_noise(path: &str) -> bool {
    let file = path.rsplit('/').next().unwrap_or(path);
    matches!(
        file,
        "package-lock.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "poetry.lock"
            | "uv.lock"
            | "Pipfile.lock"
    ) || file.ends_with(".min.js")
        || file.ends_with(".min.css")
        || file.ends_with(".bundle.js")
}

fn skip_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name) || (name.starts_with('.') && name != ".github")
}

/// Walk the repository, reading and hashing every indexable file.
///
/// The `ignore` crate walks directories on a thread pool, which is where most
/// of the gain over a sequential readdir comes from on a large tree.
pub fn walk(root: &Path) -> Vec<Scanned> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false) // our own rule below is more permissive (.github)
        // `.ignore` is a ripgrep convention, not part of SDLC's deterministic
        // repository policy. The TypeScript fallback does not read it, so the
        // native walker must not silently produce a different file set.
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .threads(std::thread::available_parallelism().map_or(4, |n| n.get()))
        .filter_entry(|entry| {
            if entry.file_type().is_some_and(|t| t.is_dir()) {
                return !skip_dir(&entry.file_name().to_string_lossy());
            }
            true
        });

    let (sender, receiver) = std::sync::mpsc::channel::<Scanned>();

    builder.build_parallel().run(|| {
        let sender = sender.clone();
        let root = root.to_path_buf();
        Box::new(move |result| {
            let Ok(entry) = result else {
                return ignore::WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return ignore::WalkState::Continue;
            }

            let Ok(relative) = entry.path().strip_prefix(&root) else {
                return ignore::WalkState::Continue;
            };
            let path = relative.to_string_lossy().replace('\\', "/");

            let lang = classify(&path);
            if lang == "other" {
                return ignore::WalkState::Continue;
            }

            let Ok(metadata) = entry.metadata() else {
                return ignore::WalkState::Continue;
            };
            if metadata.len() > MAX_FILE_BYTES {
                return ignore::WalkState::Continue;
            }

            let Ok(bytes) = std::fs::read(entry.path()) else {
                return ignore::WalkState::Continue;
            };
            if bytes.contains(&0) {
                return ignore::WalkState::Continue; // binary
            }
            // Lossy, to match the TypeScript walker: Node's utf-8 decode
            // substitutes U+FFFD and keeps the file, so rejecting it here
            // made the two paths index different file sets.
            let content = String::from_utf8_lossy(&bytes).into_owned();

            let digest = Sha256::digest(content.as_bytes());
            let content_sha: String = digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                .chars()
                .take(16)
                .collect();

            let loc = if content.is_empty() {
                0
            } else {
                content.matches('\n').count() as u32 + 1
            };

            let _ = sender.send(Scanned {
                path: path.clone(),
                lang,
                loc,
                bytes: metadata.len() as u32,
                content_sha,
                is_test: is_test_path(&path),
                content,
            });
            ignore::WalkState::Continue
        })
    });

    drop(sender);
    let mut files: Vec<Scanned> = receiver.into_iter().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

#[cfg(test)]
mod tests {
    use super::walk;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn dot_ignore_does_not_change_the_repository_map() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "sdlc-walk-ignore-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        fs::write(root.join(".ignore"), "ignored.ts\n").expect("write ignore file");
        fs::write(root.join("ignored.ts"), "export const kept = true;\n")
            .expect("write source");

        let paths: Vec<String> = walk(&root).into_iter().map(|file| file.path).collect();
        assert!(paths.contains(&"ignored.ts".to_string()));

        fs::remove_dir_all(root).expect("remove fixture");
    }
}
