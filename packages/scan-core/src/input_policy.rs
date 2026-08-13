//! The repository input boundary.
//!
//! One decision, one reason. Every path that enters or fails to enter the
//! trusted inventory passes through [`InputPolicy::decide`], and the caller is
//! told *why* rather than being handed a silent skip. Full scans and watch
//! refreshes ask the same function, so the two cannot drift apart — before
//! this, walking and watching kept parallel rules that happened to agree.
//!
//! The rule the application was missing: packaging output could enter the
//! source map. A repository's own committed `.gitignore` already says which
//! paths are output rather than source, so this consults it — and only it.
//! `.ignore`, `$GIT_DIR/info/exclude`, the global gitignore and ignore files
//! above the workspace root are all per-user or per-clone, and letting them
//! decide would mean two people scanning the same commit see different
//! repositories. That determinism, not "ignore files are untrustworthy", is
//! what the previous rule was protecting.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// Compiled policies, keyed by root. One entry per registered workspace in
/// normal use.
static POLICY_CACHE: LazyLock<Mutex<HashMap<String, (GitignoreStamp, InputPolicy)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const MAX_CACHED_POLICIES: usize = 64;

/// Enough of a `.gitignore` to tell whether it needs recompiling. Absent,
/// resized, or rewritten all read as different without opening the file.
type GitignoreStamp = Option<(u64, Option<SystemTime>)>;

fn gitignore_stamp(root: &Path) -> GitignoreStamp {
    let metadata = std::fs::metadata(root.join(".gitignore")).ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Recorded exclusions are capped; the per-reason totals are not, so a bounded
/// sample is never presented as the whole answer.
pub const MAX_RECORDED_EXCLUSIONS: usize = 2000;

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
    ".turbo",
    ".cache",
    ".parcel-cache",
];

/// Storage this application owns.
///
/// The workspace store normally lives under the user's SDLC directory, well
/// outside any indexed repository, so the walk never reaches it. These are the
/// two names that can appear *inside* a repository: the retired in-repository
/// prototype store, and a state directory a user pointed at their project.
/// Indexing them would mean indexing the index.
const APP_OWNED_DIRS: &[&str] = &["sdlc-audit", ".sdlc"];

/// Directory suffixes that mean "this is a built application, not source".
///
/// These hold even in a repository with no `.gitignore` at all, which is the
/// difference between a general input-boundary rule and a special case for one
/// project's `release/` directory.
const PACKAGED_APP_DIR_SUFFIXES: &[&str] = &[
    ".app",
    ".framework",
    ".asar",
    ".asar.unpacked",
    ".AppDir",
    ".dSYM",
    ".xcarchive",
    ".appx",
    ".bundle",
];

/// What the caller knows about the entry being classified.
///
/// `Unknown` is the watcher's case: a recursive `fs.watch` rename reports a
/// bare relative path, the old path no longer exists to stat, and directories
/// have no classifiable extension.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntryKind {
    File,
    Directory,
    Unknown,
}

/// The closed set of reasons a path is or is not part of the inventory.
///
/// Rules are evaluated in the order declared here and the first match wins, so
/// the reason reported for any path is deterministic.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reason {
    /// Inside storage this application owns, so indexing it would index itself.
    AppOwnedArtifact,
    /// Inside a built application bundle.
    PackagedApplication,
    /// The repository's own committed `.gitignore` calls this output.
    GeneratedOutput,
    /// A conventional dependency, build or tool-cache directory.
    IgnoredDirectory,
    /// A dot-prefixed directory segment, which is configuration rather than
    /// source. `.github` is the deliberate exception.
    HiddenPath,
    /// No grammar or classification covers this extension.
    UnsupportedExtension,
    TooLarge,
    BinaryContent,
    Unreadable,
    /// Indexed, but deliberately not parsed: lockfiles and bundled output.
    Noise,
    /// Indexed and parsed.
    Source,
}

impl Reason {
    /// Stable machine key. This is a closed value set and is stored in the
    /// workspace database, so the strings are part of the contract.
    pub fn key(self) -> &'static str {
        match self {
            Reason::AppOwnedArtifact => "app_owned_artifact",
            Reason::PackagedApplication => "packaged_application",
            Reason::GeneratedOutput => "generated_output",
            Reason::IgnoredDirectory => "ignored_directory",
            Reason::HiddenPath => "hidden_path",
            Reason::UnsupportedExtension => "unsupported_extension",
            Reason::TooLarge => "too_large",
            Reason::BinaryContent => "binary_content",
            Reason::Unreadable => "unreadable",
            Reason::Noise => "noise",
            Reason::Source => "source",
        }
    }

    pub fn included(self) -> bool {
        matches!(self, Reason::Source | Reason::Noise)
    }

    /// High-volume, low-value reasons are counted but not listed per path.
    /// Every `.png`, `.sh` and — since `classify` has no Rust arm — every
    /// `.rs` file in this repository lands here.
    pub fn records_paths(self) -> bool {
        !matches!(self, Reason::UnsupportedExtension | Reason::Source)
    }
}

#[derive(Clone, Debug)]
pub struct Decision {
    pub reason: Reason,
    /// Which rule matched: `node_modules`, `.gitignore:56 release/`,
    /// `SDLC.app`, `3.1 MiB exceeds 2.0 MiB`, or an OS error.
    pub detail: String,
    pub language: &'static str,
    pub is_test: bool,
    /// Not indexed itself, but editing it changes the source set, so the
    /// watcher must still refresh on it. Today: `.gitignore`.
    pub policy_input: bool,
}

impl Decision {
    pub fn included(&self) -> bool {
        self.reason.included()
    }

    pub fn parseable(&self) -> bool {
        self.reason == Reason::Source
    }

    fn excluded(reason: Reason, detail: impl Into<String>, path: &str) -> Self {
        Decision {
            reason,
            detail: detail.into(),
            language: classify(path),
            is_test: false,
            policy_input: is_policy_input(path),
        }
    }
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
    if segments.iter().any(|part| {
        matches!(
            *part,
            "test" | "tests" | "__tests__" | "spec" | "e2e" | "fixture" | "fixtures"
        )
    }) {
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

/// Files that are not indexed but decide what is.
fn is_policy_input(path: &str) -> bool {
    path == ".gitignore"
}

fn packaged_app_segment(segment: &str) -> Option<&'static str> {
    PACKAGED_APP_DIR_SUFFIXES
        .iter()
        .copied()
        .find(|suffix| segment.len() > suffix.len() && segment.ends_with(suffix))
}

fn human_bytes(bytes: u64) -> String {
    let mib = bytes as f64 / (1024.0 * 1024.0);
    format!("{mib:.1} MiB")
}

/// `Clone` is cheap and deliberate: the parallel walk needs an owned handle in
/// its `'static` closures, and `Gitignore` clones its compiled matcher rather
/// than re-reading the file.
#[derive(Clone)]
pub struct InputPolicy {
    gitignore: Option<Gitignore>,
    /// Set when a catch-all `.gitignore` would have emptied the inventory and
    /// the matcher was dropped rather than shipping an empty index.
    pub gitignore_diagnostic: Option<String>,
}

impl InputPolicy {
    /// Build the policy for one root. Reads the repository's committed
    /// `.gitignore` and nothing else.
    ///
    /// The matcher is owned here rather than switched on in `WalkBuilder`
    /// because the crate would drop entries before this module sees them —
    /// and an exclusion nobody can explain is exactly the defect being fixed.
    pub fn for_root(root: &Path) -> Self {
        let (gitignore, problem) = build_root_gitignore(root);
        InputPolicy {
            gitignore,
            gitignore_diagnostic: problem,
        }
    }

    /// The policy for a root, reusing a compiled matcher where the file has
    /// not changed.
    ///
    /// The watcher asks about every filesystem event, and rebuilding meant a
    /// read plus a glob compile per event, synchronously on the daemon's event
    /// loop — a branch switch or an install fires thousands. The metadata check
    /// stays because a `.gitignore` edit has to take effect without a restart.
    pub fn cached_for_root(root: &Path) -> Self {
        let stamp = gitignore_stamp(root);
        let key = root.to_string_lossy().into_owned();

        if let Ok(cache) = POLICY_CACHE.lock() {
            if let Some((cached_stamp, policy)) = cache.get(&key) {
                if *cached_stamp == stamp {
                    return policy.clone();
                }
            }
        }

        let policy = InputPolicy::for_root(root);
        if let Ok(mut cache) = POLICY_CACHE.lock() {
            // Bounded: one entry per registered workspace in normal use, and a
            // pathological caller cannot grow it without limit.
            if cache.len() >= MAX_CACHED_POLICIES {
                cache.clear();
            }
            cache.insert(key, (stamp, policy.clone()));
        }
        policy
    }

    /// A policy with no repository to read, for classifying a bare path.
    pub fn path_only() -> Self {
        InputPolicy {
            gitignore: None,
            gitignore_diagnostic: None,
        }
    }

    /// Drop the gitignore matcher, keeping every other rule.
    ///
    /// A repository whose `.gitignore` is `*` with tracked-file whitelisting
    /// would otherwise index nothing at all. An empty inventory is never a
    /// faithful answer, so the walk retries once without it and says so.
    pub fn without_gitignore(&self, diagnostic: String) -> Self {
        InputPolicy {
            gitignore: None,
            gitignore_diagnostic: Some(diagnostic),
        }
    }

    pub fn has_gitignore(&self) -> bool {
        self.gitignore.is_some()
    }

    /// The single inclusion decision. Path shape only; no filesystem access.
    pub fn decide(&self, relative: &str, kind: EntryKind) -> Decision {
        let path = relative.replace('\\', "/");
        let path = path.trim_start_matches("./");
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let last = segments.len().saturating_sub(1);

        for (index, segment) in segments.iter().enumerate() {
            // A trailing segment is the entry itself. Only treat it as a
            // directory rule when the caller says it is one; otherwise
            // `.mcp.json` and `dist.ts` would be excluded as directories.
            let is_interior = index < last;
            let directory_rule = is_interior || kind == EntryKind::Directory;

            if directory_rule {
                if APP_OWNED_DIRS.contains(segment) {
                    return Decision::excluded(
                        Reason::AppOwnedArtifact,
                        format!("{segment} is storage this application owns"),
                        path,
                    );
                }
                if let Some(suffix) = packaged_app_segment(segment) {
                    return Decision::excluded(
                        Reason::PackagedApplication,
                        format!("{segment} is a packaged {suffix} bundle"),
                        path,
                    );
                }
                if IGNORED_DIRS.contains(segment) {
                    return Decision::excluded(Reason::IgnoredDirectory, *segment, path);
                }
                if segment.starts_with('.') && *segment != ".github" {
                    return Decision::excluded(Reason::HiddenPath, *segment, path);
                }
            }
        }

        if let Some(gitignore) = &self.gitignore {
            let matched = gitignore.matched_path_or_any_parents(path, kind == EntryKind::Directory);
            if let ignore::Match::Ignore(glob) = matched {
                return Decision::excluded(Reason::GeneratedOutput, describe_glob(glob), path);
            }
        }

        // Directories carry no content decision. Everything below is about the
        // file itself.
        if kind == EntryKind::Directory {
            return Decision {
                reason: Reason::Source,
                detail: String::new(),
                language: "other",
                is_test: false,
                policy_input: false,
            };
        }

        let language = classify(path);
        if language == "other" {
            let extension = match path.rfind('.') {
                Some(index) => path[index..].to_ascii_lowercase(),
                None => "(no extension)".to_string(),
            };
            return Decision {
                reason: Reason::UnsupportedExtension,
                detail: extension,
                language,
                is_test: false,
                policy_input: is_policy_input(path),
            };
        }

        Decision {
            reason: if is_noise(path) {
                Reason::Noise
            } else {
                Reason::Source
            },
            detail: String::new(),
            language,
            is_test: is_test_path(path),
            policy_input: is_policy_input(path),
        }
    }

    /// The size rule, which must be answered *before* the file is read.
    ///
    /// Reading first and checking after would let one very large file allocate
    /// its whole length in every parallel worker that reaches it.
    pub fn decide_size(&self, path: &str, len: u64) -> Option<Decision> {
        if len > MAX_FILE_BYTES {
            return Some(Decision::excluded(
                Reason::TooLarge,
                format!(
                    "{} exceeds {}",
                    human_bytes(len),
                    human_bytes(MAX_FILE_BYTES)
                ),
                path,
            ));
        }
        None
    }

    /// The rules that need the bytes. `None` means keep the file.
    ///
    /// The length is re-checked here because metadata is a separate syscall:
    /// a file can grow between the two, and the cap has to hold on what was
    /// actually read.
    pub fn decide_content(&self, path: &str, bytes: &[u8]) -> Option<Decision> {
        if let Some(rejected) = self.decide_size(path, bytes.len() as u64) {
            return Some(rejected);
        }
        if bytes.contains(&0) {
            return Some(Decision::excluded(
                Reason::BinaryContent,
                "contains a NUL byte",
                path,
            ));
        }
        None
    }

    pub fn unreadable(&self, path: &str, detail: impl Into<String>) -> Decision {
        Decision::excluded(Reason::Unreadable, detail, path)
    }
}

fn describe_glob(glob: &ignore::gitignore::Glob) -> String {
    let source = glob
        .from()
        .and_then(|from| from.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".gitignore".to_string());
    format!("{source} rule \"{}\"", glob.original())
}

/// Only the root `.gitignore`. Nested per-package files are a later additive
/// step: missing one leaves files *included*, which is the safe direction.
///
/// Returns the matcher and any problem building it. A rule that could not be
/// applied is a gap, not a pass: silently dropping it would index generated
/// output with nothing anywhere saying the policy was incomplete.
fn build_root_gitignore(root: &Path) -> (Option<Gitignore>, Option<String>) {
    let file = root.join(".gitignore");
    if !file.is_file() {
        return (None, None);
    }
    let mut builder = GitignoreBuilder::new(root);
    let mut problem = builder
        .add(&file)
        .map(|error| format!("Some .gitignore rules could not be read: {error}."));
    match builder.build() {
        Ok(matcher) => (Some(matcher), problem),
        Err(error) => {
            problem = Some(format!(
                "This repository's .gitignore could not be compiled ({error}), so generated \
                 output may be indexed as source. Fix the file and re-index."
            ));
            (None, problem)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "sdlc-policy-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    fn bare(root: &Path) -> InputPolicy {
        InputPolicy::for_root(root)
    }

    #[test]
    fn packaged_application_output_cannot_enter_the_inventory() {
        let root = fixture_root("packaged");
        let policy = bare(&root);

        // The exact paths observed leaking into this repository's own map.
        for path in [
            "release/mac-arm64/SDLC.app/Contents/Resources/app/preload.cjs",
            "release/mac-arm64/SDLC.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/vk_swiftshader_icd.json",
            "dist/win-unpacked/resources/app.asar.unpacked/main.js",
            "build/Foo.AppDir/usr/bin/app.json",
        ] {
            let decision = policy.decide(path, EntryKind::File);
            assert!(!decision.included(), "{path} should be excluded");
        }

        // A bundle reached without passing through an ignored directory still
        // has to be caught by the packaged-application rule alone.
        let decision = policy.decide("artifacts/SDLC.app/Contents/Resources/app/preload.cjs", EntryKind::File);
        assert_eq!(decision.reason, Reason::PackagedApplication);
        assert!(decision.detail.contains("SDLC.app"));

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_committed_gitignore_excludes_generated_output_and_names_its_rule() {
        let root = fixture_root("gitignore");
        fs::write(root.join(".gitignore"), "release/\n*.generated.ts\n").expect("write gitignore");
        let policy = bare(&root);

        let decision = policy.decide("release/builder-debug.yml", EntryKind::File);
        assert_eq!(decision.reason, Reason::GeneratedOutput);
        assert!(
            decision.detail.contains("release/"),
            "expected the matched rule, got {}",
            decision.detail
        );

        assert_eq!(
            policy.decide("src/api.generated.ts", EntryKind::File).reason,
            Reason::GeneratedOutput
        );
        assert!(policy.decide("src/api.ts", EntryKind::File).included());

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn gitignore_negation_keeps_a_whitelisted_file() {
        let root = fixture_root("negation");
        fs::write(root.join(".gitignore"), "*.json\n!keep.json\n").expect("write gitignore");
        let policy = bare(&root);

        assert!(!policy.decide("drop.json", EntryKind::File).included());
        assert!(policy.decide("keep.json", EntryKind::File).included());

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn user_local_ignore_files_still_do_not_decide_the_source_set() {
        // Both halves of the rationale in one test: a committed .gitignore is
        // repository policy, a .ignore file is one machine's preference.
        let root = fixture_root("ignore-precedence");
        fs::write(root.join(".ignore"), "ignored.ts\n").expect("write ignore");
        fs::write(root.join(".gitignore"), "generated.ts\n").expect("write gitignore");
        let policy = bare(&root);

        assert!(policy.decide("ignored.ts", EntryKind::File).included());
        assert!(!policy.decide("generated.ts", EntryKind::File).included());

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn application_owned_storage_is_never_indexed_as_source() {
        let root = fixture_root("app-owned");
        let policy = bare(&root);

        // The retired in-repository prototype store and a state directory
        // pointed at a project both index the index if allowed through.
        for path in ["sdlc-audit/audit.db.json", ".sdlc/stores/a/audit.db-wal"] {
            let decision = policy.decide(path, EntryKind::File);
            assert_eq!(
                decision.reason,
                Reason::AppOwnedArtifact,
                "{path} should be reported as application-owned"
            );
        }
        assert!(policy.decide("src/audit.ts", EntryKind::File).included());

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn entry_kind_settles_the_hidden_segment_question() {
        let root = fixture_root("hidden");
        let policy = bare(&root);

        // A hidden directory is configuration, audited separately.
        assert!(!policy.decide(".codex", EntryKind::Directory).included());
        assert!(!policy.decide(".codex/config.toml", EntryKind::File).included());
        assert!(!policy.decide("src/.hidden/app.ts", EntryKind::File).included());

        // A hidden *file* at the end of a path is an indexed input.
        assert!(policy.decide(".mcp.json", EntryKind::File).included());
        assert!(policy
            .decide(".github/workflows/ci.yml", EntryKind::File)
            .included());

        // The watcher cannot always tell, and a rename must survive that.
        assert!(policy.decide(".mcp.json", EntryKind::Unknown).included());

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn content_rules_report_size_and_binary_separately() {
        let root = fixture_root("content");
        let policy = bare(&root);

        // Size is answerable from metadata alone, which is what keeps an
        // oversized file from ever being read into memory.
        let large = policy
            .decide_size("src/big.ts", MAX_FILE_BYTES + 1)
            .expect("oversized file is excluded before it is read");
        assert_eq!(large.reason, Reason::TooLarge);
        assert!(large.detail.contains("exceeds"));
        assert!(policy.decide_size("src/small.ts", 1024).is_none());

        let binary = policy
            .decide_content("src/logo.ts", b"abc\0def")
            .expect("binary file is excluded");
        assert_eq!(binary.reason, Reason::BinaryContent);

        assert!(policy.decide_content("src/ok.ts", b"export {};").is_none());

        // A file that grew between the metadata call and the read is still
        // capped on what was actually read.
        let grown = vec![b'x'; (MAX_FILE_BYTES + 1) as usize];
        assert_eq!(
            policy
                .decide_content("src/grew.ts", &grown)
                .expect("a file that grew past the cap is excluded")
                .reason,
            Reason::TooLarge
        );

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn classification_and_noise_survive_the_move_from_walk() {
        let root = fixture_root("classify");
        let policy = bare(&root);

        assert_eq!(classify("src/app.ts"), "typescript");
        assert_eq!(classify(".mcp.json"), "config");
        assert_eq!(classify(".DS_Store"), "other");
        assert!(is_test_path("src/app.test.ts"));
        assert!(is_test_path("packages/engine/fixtures/eval/src/http.ts"));

        // Noise is indexed but not parsed — an inventory fact, not an exclusion.
        let lock = policy.decide("package-lock.json", EntryKind::File);
        assert_eq!(lock.reason, Reason::Noise);
        assert!(lock.included());
        assert!(!lock.parseable());

        let unsupported = policy.decide("assets/logo.png", EntryKind::File);
        assert_eq!(unsupported.reason, Reason::UnsupportedExtension);
        assert!(!unsupported.reason.records_paths());

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn gitignore_is_a_policy_input_the_watcher_must_still_see() {
        let root = fixture_root("policy-input");
        fs::write(root.join(".gitignore"), "release/\n").expect("write gitignore");
        let policy = bare(&root);

        let decision = policy.decide(".gitignore", EntryKind::File);
        assert!(decision.policy_input);

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn rule_order_is_deterministic_when_several_rules_match() {
        let root = fixture_root("order");
        fs::write(root.join(".gitignore"), "node_modules/\n").expect("write gitignore");
        let policy = bare(&root);

        // Both the ignored-directory list and .gitignore match; the declared
        // order decides, so the reported reason never depends on rule input.
        assert_eq!(
            policy
                .decide("node_modules/pkg/index.ts", EntryKind::File)
                .reason,
            Reason::IgnoredDirectory
        );

        fs::remove_dir_all(root).expect("remove fixture");
    }
}
