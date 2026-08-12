//! Parallel repository walk.
//!
//! This is the single repository-inventory policy for the application. The
//! daemon asks this module about watcher paths as well as using it for scans,
//! so a second implementation cannot silently drift from the trusted input
//! boundary.

use ignore::WalkBuilder;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".tox",
    "target",
    "vendor",
    "site-packages",
    ".eggs",
    "htmlcov",
    ".idea",
    ".vscode",
    "sdlc-audit",
    ".turbo",
    ".cache",
    ".parcel-cache",
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

/// Test-file conventions supported by the repository inventory.
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
            if matches!(
                suffix,
                "ts" | "tsx" | "js" | "jsx" | "mts" | "mjs" | "cts" | "cjs"
            ) {
                return true;
            }
        }
    }

    file == "conftest.py"
        || file.ends_with("_test.py")
        || file.starts_with("test_") && file.ends_with(".py")
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

pub fn skip_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name) || (name.starts_with('.') && name != ".github")
}

pub fn is_watch_ignored_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    segments.iter().enumerate().any(|(index, segment)| {
        IGNORED_DIRS.contains(segment)
            // A final dot-prefixed segment can be a valid file such as
            // `.mcp.json`. Hidden directories are excluded from both source
            // inventory and source refreshes, except for `.github`.
            || (index + 1 < segments.len()
                && segment.starts_with('.')
                && *segment != ".github")
    })
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
        // repository policy. User-local ignore files must not silently change
        // the source set represented by the application.
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
            // Decode lossily so one malformed byte does not make an otherwise
            // indexable text file disappear from the repository inventory.
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
    use super::{classify, is_noise, is_test_path, is_watch_ignored_path, walk};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn dot_ignore_does_not_change_the_repository_map() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("sdlc-walk-ignore-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).expect("create fixture");
        fs::create_dir_all(root.join(".codex")).expect("create agent config directory");
        fs::create_dir_all(root.join(".hidden")).expect("create hidden directory");
        fs::write(root.join(".ignore"), "ignored.ts\n").expect("write ignore file");
        fs::write(root.join("ignored.ts"), "export const kept = true;\n").expect("write source");
        fs::write(root.join(".codex/config.toml"), "model = 'fixture'\n")
            .expect("write agent config");
        fs::write(root.join(".hidden/config.toml"), "secret = true\n")
            .expect("write hidden config");

        let paths: Vec<String> = walk(&root).into_iter().map(|file| file.path).collect();
        assert!(paths.contains(&"ignored.ts".to_string()));
        assert!(!paths.contains(&".codex/config.toml".to_string()));
        assert!(!paths.contains(&".hidden/config.toml".to_string()));

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn rust_policy_classifies_scans_and_watcher_paths() {
        assert_eq!(classify("src/app.ts"), "typescript");
        assert_eq!(classify(".mcp.json"), "config");
        assert_eq!(classify(".DS_Store"), "other");
        assert!(is_test_path("src/app.test.ts"));
        assert!(is_noise("dist/app.min.js"));
        assert!(is_watch_ignored_path("node_modules/pkg/index.ts"));
        assert!(is_watch_ignored_path("src/.hidden/app.ts"));
        assert!(!is_watch_ignored_path(".mcp.json"));
        assert!(is_watch_ignored_path(".codex/config.toml"));
        assert!(!is_watch_ignored_path(".github/workflows/ci.yml"));
    }
}
