//! Bounded working-tree change discovery through Git's stable porcelain format.
//!
//! Git owns repository semantics, ignore rules, staging, renames, and platform
//! behavior. SDLC only normalizes that mature tool's machine-readable output
//! into repository-relative paths for retrieval; it does not implement a diff
//! engine or infer changes from file timestamps.

use crate::{NativeGitChange, NativeGitChangeSet};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::{Component, Path};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

const MAX_CHANGES: usize = 256;
const MAX_CHANGE_PATH_BYTES: usize = 4_096;
const MAX_DIAGNOSTIC_BYTES: usize = 400;
const MAX_PREFIX_BYTES: usize = 4_096;
const MAX_STATUS_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const PREFIX_TIMEOUT: Duration = Duration::from_secs(5);
const STATUS_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(windows)]
const NULL_GIT_CONFIG: &str = "NUL";
#[cfg(not(windows))]
const NULL_GIT_CONFIG: &str = "/dev/null";
const REPOSITORY_SELECTOR_ENV: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DIR",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_INTERNAL_SUPER_PREFIX",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
];

struct BoundedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    timed_out: bool,
}

fn bounded_reader<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
    exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<io::Result<(Vec<u8>, bool)>> {
    thread::spawn(move || {
        let mut retained = Vec::with_capacity(limit.min(64 * 1024));
        let mut buffer = [0_u8; 8 * 1024];
        let mut truncated = false;
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            let available = limit.saturating_sub(retained.len());
            retained.extend_from_slice(&buffer[..count.min(available)]);
            if count > available {
                truncated = true;
                exceeded.store(true, Ordering::Release);
            }
        }
        Ok((retained, truncated))
    })
}

fn join_reader(
    handle: thread::JoinHandle<io::Result<(Vec<u8>, bool)>>,
) -> io::Result<(Vec<u8>, bool)> {
    handle
        .join()
        .map_err(|_| io::Error::other("Git output reader panicked"))?
}

fn git_output(
    root: &str,
    args: &[&str],
    stdout_limit: usize,
    timeout: Duration,
    isolated_config: bool,
) -> io::Result<BoundedOutput> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in REPOSITORY_SELECTOR_ENV {
        command.env_remove(key);
    }
    // `GIT_CONFIG_COUNT` introduces a dynamic set of repository-affecting
    // variables. They are process-local command selectors, not user Git
    // configuration, so do not let a parent Git command retarget the daemon.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_CONFIG_KEY_")
            || key.to_string_lossy().starts_with("GIT_CONFIG_VALUE_")
        {
            command.env_remove(key);
        }
    }
    if isolated_config {
        command
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", NULL_GIT_CONFIG)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env_remove("GIT_TEMPLATE_DIR");
    }
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Git stdout pipe was unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Git stderr pipe was unavailable"))?;
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_reader = bounded_reader(stdout, stdout_limit, Arc::clone(&exceeded));
    let stderr_reader = bounded_reader(stderr, MAX_STDERR_BYTES, Arc::clone(&exceeded));
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if exceeded.load(Ordering::Acquire) {
            let _ = child.kill();
            break child.wait()?;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let (stdout, stdout_truncated) = join_reader(stdout_reader)?;
    let (stderr, stderr_truncated) = join_reader(stderr_reader)?;
    Ok(BoundedOutput {
        status,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        timed_out,
    })
}

fn bounded_diagnostic(bytes: &[u8]) -> Option<String> {
    let value = String::from_utf8_lossy(bytes).trim().to_string();
    if value.is_empty() {
        return None;
    }
    let mut end = value.len().min(MAX_DIAGNOSTIC_BYTES);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    Some(if end < value.len() {
        format!("{}…", value[..end].trim_end())
    } else {
        value
    })
}

/// A path from outside, confined to somewhere inside the workspace.
///
/// One definition, shared with the task planner, because two copies of a
/// confinement rule is two chances to get it wrong on one platform — which is
/// what happened. `is_absolute` is not the test it looks like: on Windows a
/// path is absolute only with a drive or UNC prefix, so `/escape.ts` is not
/// absolute there and slipped straight through a check that rejected it on
/// Unix. `RootDir` is the component that actually means "rooted", and it means
/// it everywhere.
pub(crate) fn confined_relative_path(value: &str) -> Option<String> {
    let path = value.replace('\\', "/");
    if path.is_empty()
        || path.len() > MAX_CHANGE_PATH_BYTES
        || Path::new(&path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let normalized = path.trim_start_matches("./");
    (!normalized.is_empty()).then(|| normalized.to_string())
}

fn normalized_path(bytes: &[u8]) -> Option<String> {
    confined_relative_path(std::str::from_utf8(bytes).ok()?)
}

fn project_relative_path(bytes: &[u8], repository_prefix: &str) -> Option<String> {
    let path = normalized_path(bytes)?;
    if repository_prefix.is_empty() {
        return Some(path);
    }
    path.strip_prefix(repository_prefix).map(str::to_string)
}

fn tail_after_spaces(record: &[u8], spaces: usize) -> Option<&[u8]> {
    let mut seen = 0;
    for (index, byte) in record.iter().enumerate() {
        if *byte != b' ' {
            continue;
        }
        seen += 1;
        if seen == spaces {
            return Some(&record[index + 1..]);
        }
    }
    None
}

fn status_name(code: u8) -> &'static str {
    match code {
        b'.' => "unchanged",
        b'M' => "modified",
        b'T' => "type-changed",
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "copied",
        b'U' => "unmerged",
        _ => "unknown",
    }
}

fn status_label(record_kind: u8, index: u8, worktree: u8) -> String {
    if record_kind == b'?' {
        return "untracked".to_string();
    }
    if record_kind == b'u' || index == b'U' || worktree == b'U' {
        return "unmerged".to_string();
    }
    let index_name = status_name(index);
    let worktree_name = status_name(worktree);
    match (index_name, worktree_name) {
        ("unchanged", worktree) => worktree.to_string(),
        (index, "unchanged") => format!("staged-{index}"),
        (index, worktree) if index == worktree => format!("staged-and-{worktree}"),
        (index, worktree) => format!("staged-{index}-and-{worktree}"),
    }
}

fn merge_status_code(existing: &str, incoming: &str) -> String {
    if existing == incoming || incoming == "." {
        return existing.to_string();
    }
    if existing == "." {
        return incoming.to_string();
    }
    // `?` is not an XY status. When Git emits a second untracked record for
    // the same path, retain the staged/index status in the structured field;
    // the human label below still records both facts.
    if incoming == "?" {
        return existing.to_string();
    }
    if existing == "?" {
        return incoming.to_string();
    }
    format!("{existing}+{incoming}")
}

fn merge_change(existing: &mut NativeGitChange, incoming: NativeGitChange) {
    if existing.status != incoming.status {
        existing.status = format!("{} + {}", existing.status, incoming.status);
    }
    existing.index_status = merge_status_code(&existing.index_status, &incoming.index_status);
    existing.worktree_status =
        merge_status_code(&existing.worktree_status, &incoming.worktree_status);
    if existing.previous_path.is_none() {
        existing.previous_path = incoming.previous_path;
    }
}

fn parse_porcelain(output: &[u8], repository_prefix: &str) -> (Vec<NativeGitChange>, usize, bool) {
    let records = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut changes = BTreeMap::<String, NativeGitChange>::new();
    let mut invalid = false;
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() || record[0] == b'#' || record[0] == b'!' {
            continue;
        }
        let (path_bytes, previous_path, index_status, worktree_status) = match record[0] {
            b'1' => (
                tail_after_spaces(record, 8),
                None,
                record.get(2).copied().unwrap_or(b'?'),
                record.get(3).copied().unwrap_or(b'?'),
            ),
            b'2' => {
                let previous = records.get(index).copied();
                if previous.is_some() {
                    index += 1;
                }
                (
                    tail_after_spaces(record, 9),
                    previous.and_then(|path| project_relative_path(path, repository_prefix)),
                    record.get(2).copied().unwrap_or(b'?'),
                    record.get(3).copied().unwrap_or(b'?'),
                )
            }
            b'u' => (
                tail_after_spaces(record, 10),
                None,
                record.get(2).copied().unwrap_or(b'U'),
                record.get(3).copied().unwrap_or(b'U'),
            ),
            b'?' => (Some(record.get(2..).unwrap_or_default()), None, b'?', b'?'),
            _ => {
                invalid = true;
                continue;
            }
        };
        let Some(path) = path_bytes.and_then(|path| project_relative_path(path, repository_prefix))
        else {
            invalid = true;
            continue;
        };
        let record_kind = record[0];
        let change = NativeGitChange {
            path: path.clone(),
            previous_path,
            status: status_label(record_kind, index_status, worktree_status),
            index_status: char::from(index_status).to_string(),
            worktree_status: char::from(worktree_status).to_string(),
            worktree_path_present: None,
        };
        match changes.entry(path) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(change);
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                merge_change(entry.get_mut(), change);
            }
        }
    }
    let detected = changes.len();
    let truncated = detected > MAX_CHANGES || invalid;
    (
        changes.into_values().take(MAX_CHANGES).collect(),
        detected,
        truncated,
    )
}

pub(crate) fn detect(root: &str, isolated_config: bool) -> NativeGitChangeSet {
    let prefix_output = git_output(
        root,
        &["rev-parse", "--show-prefix"],
        MAX_PREFIX_BYTES,
        PREFIX_TIMEOUT,
        isolated_config,
    );
    let prefix_output = match prefix_output {
        Ok(output) => output,
        Err(error) => {
            return NativeGitChangeSet {
                state: "unavailable".to_string(),
                source: "git-status-porcelain-v2".to_string(),
                changes: Vec::new(),
                detected_paths: 0,
                truncated: false,
                diagnostic: Some(format!("Git could not be started: {error}")),
            };
        }
    };
    if prefix_output.timed_out || prefix_output.stdout_truncated || prefix_output.stderr_truncated {
        return NativeGitChangeSet {
            state: "unavailable".to_string(),
            source: "git-status-porcelain-v2".to_string(),
            changes: Vec::new(),
            detected_paths: 0,
            truncated: true,
            diagnostic: Some(
                "Git repository discovery exceeded its time or output bound.".to_string(),
            ),
        };
    }
    if !prefix_output.status.success() {
        let diagnostic = bounded_diagnostic(&prefix_output.stderr)
            .or_else(|| bounded_diagnostic(&prefix_output.stdout))
            .unwrap_or_else(|| format!("git rev-parse exited with {}", prefix_output.status));
        let state = if diagnostic.to_lowercase().contains("not a git repository") {
            "not-repository"
        } else {
            "unavailable"
        };
        return NativeGitChangeSet {
            state: state.to_string(),
            source: "git-status-porcelain-v2".to_string(),
            changes: Vec::new(),
            detected_paths: 0,
            truncated: false,
            diagnostic: Some(diagnostic),
        };
    }
    let repository_prefix = match std::str::from_utf8(&prefix_output.stdout) {
        Ok(prefix) => prefix.trim().replace('\\', "/"),
        Err(_) => {
            return NativeGitChangeSet {
                state: "unavailable".to_string(),
                source: "git-status-porcelain-v2".to_string(),
                changes: Vec::new(),
                detected_paths: 0,
                truncated: false,
                diagnostic: Some("Git returned a non-UTF-8 repository prefix.".to_string()),
            };
        }
    };
    let output = git_output(
        root,
        &[
            "-c",
            "status.relativePaths=false",
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
            "--",
            ".",
        ],
        MAX_STATUS_BYTES,
        STATUS_TIMEOUT,
        isolated_config,
    );
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            return NativeGitChangeSet {
                state: "unavailable".to_string(),
                source: "git-status-porcelain-v2".to_string(),
                changes: Vec::new(),
                detected_paths: 0,
                truncated: false,
                diagnostic: Some(format!("Git could not be started: {error}")),
            };
        }
    };
    let bounded_partial = output.timed_out || output.stdout_truncated || output.stderr_truncated;
    if !output.status.success() && !bounded_partial {
        let diagnostic = bounded_diagnostic(&output.stderr)
            .or_else(|| bounded_diagnostic(&output.stdout))
            .unwrap_or_else(|| format!("git status exited with {}", output.status));
        let state = if diagnostic.to_lowercase().contains("not a git repository") {
            "not-repository"
        } else {
            "unavailable"
        };
        return NativeGitChangeSet {
            state: state.to_string(),
            source: "git-status-porcelain-v2".to_string(),
            changes: Vec::new(),
            detected_paths: 0,
            truncated: false,
            diagnostic: Some(diagnostic),
        };
    }

    let (mut changes, detected_paths, parse_truncated) =
        parse_porcelain(&output.stdout, &repository_prefix);
    for change in &mut changes {
        change.worktree_path_present =
            match std::fs::symlink_metadata(Path::new(root).join(&change.path)) {
                Ok(metadata) => Some(metadata.file_type().is_file()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Some(false),
                Err(_) => None,
            };
    }
    let truncated = parse_truncated || bounded_partial;
    let diagnostic = if output.timed_out {
        Some("Git status exceeded 30 seconds; this is a bounded partial change set.".to_string())
    } else if output.stdout_truncated || output.stderr_truncated {
        Some(
            "Git status exceeded its bounded output envelope; this is a partial change set."
                .to_string(),
        )
    } else if parse_truncated {
        Some(
            "Some changed paths were omitted because the working-tree result exceeded the bounded or UTF-8-safe retrieval envelope."
                .to_string(),
        )
    } else {
        None
    };
    NativeGitChangeSet {
        state: "available".to_string(),
        source: "git-status-porcelain-v2".to_string(),
        changes,
        detected_paths: u32::try_from(detected_paths).unwrap_or(u32::MAX),
        truncated,
        diagnostic,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRepository {
        root: PathBuf,
    }

    static GIT_ENV_MUTEX: Mutex<()> = Mutex::new(());

    struct EnvironmentGuard {
        key: &'static str,
        original: Option<OsString>,
    }

    impl EnvironmentGuard {
        fn set(key: &'static str, value: &Path) -> Self {
            let original = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, original }
        }
    }

    impl Drop for EnvironmentGuard {
        fn drop(&mut self) {
            if let Some(value) = self.original.as_ref() {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn test_repository() -> TestRepository {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should follow the Unix epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("sdlc-git-changes-{}-{unique}", std::process::id()));
        fs::create_dir_all(&root).expect("test repository should be created");
        let status = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "--quiet"])
            .status()
            .expect("Git should be available for change detection tests");
        assert!(status.success(), "Git repository initialization failed");
        TestRepository { root }
    }

    #[test]
    fn parses_modified_untracked_and_renamed_paths_without_shell_quoting() {
        let output = b"1 .M N... 100644 100644 100644 abc abc src/a file.ts\0\
                       ? src/new file.ts\0\
                       2 R. N... 100644 100644 100644 abc abc R100 src/renamed.ts\0src/old.ts\0";
        let (changes, detected, truncated) = parse_porcelain(output, "");
        assert_eq!(detected, 3);
        assert!(!truncated);
        assert_eq!(
            changes
                .iter()
                .map(|change| (change.path.as_str(), change.status.as_str()))
                .collect::<Vec<_>>(),
            [
                ("src/a file.ts", "modified"),
                ("src/new file.ts", "untracked"),
                ("src/renamed.ts", "staged-renamed"),
            ]
        );
        assert_eq!(changes[2].previous_path.as_deref(), Some("src/old.ts"));
    }

    #[test]
    fn merges_staged_deletion_and_untracked_recreation_for_one_path() {
        let output = b"1 D. N... 100644 000000 000000 abc 000 src/a.ts\0? src/a.ts\0";
        let (changes, detected, truncated) = parse_porcelain(output, "");
        assert_eq!(detected, 1);
        assert!(!truncated);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].status, "staged-deleted + untracked");
        assert_eq!(changes[0].index_status, "D");
        assert_eq!(changes[0].worktree_status, "?");
    }

    #[test]
    fn rejects_paths_that_escape_the_requested_workspace() {
        let output = b"? ../outside.ts\0? /absolute.ts\0? src/inside.ts\0";
        let (changes, detected, truncated) = parse_porcelain(output, "");
        assert_eq!(detected, 1);
        assert!(truncated);
        assert_eq!(changes[0].path, "src/inside.ts");
    }

    #[test]
    fn a_rooted_path_escapes_on_every_platform_or_none() {
        // The rule this pins is that confinement does not depend on what the
        // platform calls "absolute". Windows reserves that for a path with a
        // drive or UNC prefix, so `/escape.ts` is not absolute there — and an
        // `is_absolute` check rejected it on Unix while letting it through on
        // Windows, where these tests had never run.
        for escaping in [
            "/escape.ts",
            "../escape.ts",
            "src/../../escape.ts",
            "./../escape.ts",
        ] {
            assert_eq!(
                confined_relative_path(escaping),
                None,
                "{escaping} leaves the workspace"
            );
        }

        // A backslash is a separator, not a name, so this is the same path.
        assert_eq!(confined_relative_path("\\escape.ts"), None);

        for inside in ["src/inside.ts", "./src/inside.ts", "inside.ts"] {
            assert!(
                confined_relative_path(inside).is_some(),
                "{inside} stays inside"
            );
        }
        assert_eq!(
            confined_relative_path("./src/inside.ts").as_deref(),
            Some("src/inside.ts")
        );
    }

    #[test]
    fn strips_the_git_top_level_prefix_for_nested_projects() {
        let output = b"1 .M N... 100644 100644 100644 abc abc apps/api/src/main.ts\0";
        let (changes, detected, truncated) = parse_porcelain(output, "apps/api/");
        assert_eq!(detected, 1);
        assert!(!truncated);
        assert_eq!(changes[0].path, "src/main.ts");
    }

    #[test]
    fn detects_changes_from_a_nested_project_root() {
        let _environment = GIT_ENV_MUTEX.lock().expect("Git environment lock");
        let repository = test_repository();
        let project = repository.root.join("apps/api");
        fs::create_dir_all(project.join("src")).expect("nested source directory should be created");
        fs::write(project.join("src/main.ts"), "export const ready = true;\n")
            .expect("nested source file should be created");
        let _ceiling =
            EnvironmentGuard::set("GIT_CEILING_DIRECTORIES", &repository.root.join("apps"));

        let changes = detect(project.to_str().expect("test path should be UTF-8"), true);

        assert_eq!(changes.state, "available");
        assert!(!changes.truncated, "{:?}", changes.diagnostic);
        assert_eq!(changes.detected_paths, 1);
        assert_eq!(changes.changes.len(), 1);
        assert_eq!(changes.changes[0].path, "src/main.ts");
        assert_eq!(changes.changes[0].status, "untracked");
        assert_eq!(changes.changes[0].worktree_path_present, Some(true));
    }

    #[test]
    fn clears_inherited_repository_selectors() {
        let _environment = GIT_ENV_MUTEX.lock().expect("Git environment lock");
        let requested = test_repository();
        let redirected = test_repository();
        fs::create_dir_all(requested.root.join("src"))
            .expect("requested source directory should be created");
        fs::write(
            requested.root.join("src/main.ts"),
            "export const requested = true;\n",
        )
        .expect("requested source file should be created");
        let _git_dir = EnvironmentGuard::set("GIT_DIR", &redirected.root.join(".git"));
        let _work_tree = EnvironmentGuard::set("GIT_WORK_TREE", &redirected.root);

        let changes = detect(
            requested.root.to_str().expect("test path should be UTF-8"),
            true,
        );

        assert_eq!(changes.state, "available");
        assert!(!changes.truncated, "{:?}", changes.diagnostic);
        assert_eq!(changes.detected_paths, 1);
        assert_eq!(changes.changes[0].path, "src/main.ts");
    }

    #[test]
    fn caps_the_normalized_change_set() {
        let output = (0..=MAX_CHANGES)
            .map(|index| format!("? src/{index:03}.ts\0"))
            .collect::<String>();
        let (changes, detected, truncated) = parse_porcelain(output.as_bytes(), "");
        assert_eq!(changes.len(), MAX_CHANGES);
        assert_eq!(detected, MAX_CHANGES + 1);
        assert!(truncated);
    }
}
