//! Parallel repository walk.
//!
//! Traversal, reading and hashing only. Every question about whether a path
//! belongs in the inventory is answered by [`crate::input_policy`], which the
//! watcher asks too — so a second implementation cannot silently drift from
//! the trusted input boundary.
//!
//! Skipping used to be invisible: seven different conditions all ended in a
//! bare `WalkState::Continue`, so a file that never appeared was
//! indistinguishable from one that was never there. Every skip now carries its
//! reason out with it.

use crate::input_policy::{Decision, EntryKind, InputPolicy, Reason, MAX_RECORDED_EXCLUSIONS};
use ignore::WalkBuilder;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct Scanned {
    pub path: String,
    pub lang: &'static str,
    pub loc: u32,
    pub bytes: u32,
    pub content_sha: String,
    pub is_test: bool,
    /// False for lockfiles and bundled output, which are inventory but not
    /// evidence. Decided once by the policy rather than re-derived downstream.
    pub parseable: bool,
    /// The filesystem's identity for this file, or `None` when it cannot serve
    /// as a baseline for a later scan. See [`crate::freshness`].
    pub stat_key: Option<String>,
    pub content: String,
}

/// One recorded exclusion. A pruned directory is one decision, not one per
/// file underneath it — the interior is never enumerated, which is what keeps
/// this bounded without an arbitrary cap doing the work.
pub struct Excluded {
    pub path: String,
    pub directory: bool,
    pub reason: &'static str,
    pub detail: String,
}

pub struct ReasonCount {
    pub reason: &'static str,
    /// Every decision with this reason, including ones not recorded per path.
    pub paths: u32,
    pub recorded: u32,
}

pub struct WalkOutcome {
    pub files: Vec<Scanned>,
    pub excluded: Vec<Excluded>,
    pub summary: Vec<ReasonCount>,
    /// Anything the caller should be told about the policy: a rule that could
    /// not be read, or a matcher that had to be dropped.
    pub diagnostic: Option<String>,
    /// False only when the gitignore matcher was abandoned for this walk. A
    /// malformed rule still leaves the rest applied, which is a different
    /// thing — and the watcher has to make the same distinction or it stops
    /// refreshing files the scan actually indexed.
    pub gitignore_applied: bool,
}

#[derive(Default)]
struct Collector {
    excluded: Vec<Excluded>,
    totals: BTreeMap<&'static str, u32>,
    recorded: BTreeMap<&'static str, u32>,
}

impl Collector {
    /// Count a decision without listing its path. Included files land here.
    fn count(&mut self, decision: &Decision) {
        *self.totals.entry(decision.reason.key()).or_insert(0) += 1;
    }

    fn record(&mut self, path: &str, directory: bool, decision: &Decision) {
        let key = decision.reason.key();
        self.count(decision);
        if !decision.reason.records_paths() || self.excluded.len() >= MAX_RECORDED_EXCLUSIONS {
            return;
        }
        *self.recorded.entry(key).or_insert(0) += 1;
        self.excluded.push(Excluded {
            path: path.to_string(),
            directory,
            reason: key,
            detail: decision.detail.clone(),
        });
    }

    fn finish(self) -> (Vec<Excluded>, Vec<ReasonCount>) {
        let summary = self
            .totals
            .iter()
            .map(|(reason, paths)| ReasonCount {
                reason,
                paths: *paths,
                recorded: self.recorded.get(reason).copied().unwrap_or(0),
            })
            .collect();
        (self.excluded, summary)
    }
}

fn relative_path(root: &Path, entry: &Path) -> Option<String> {
    let relative = entry.strip_prefix(root).ok()?;
    let path = relative.to_string_lossy().replace('\\', "/");
    if path.is_empty() {
        None // The root itself is not a candidate.
    } else {
        Some(path)
    }
}

/// Walk the repository, reading and hashing every indexable file.
///
/// The `ignore` crate walks directories on a thread pool, which is where most
/// of the gain over a sequential readdir comes from on a large tree. Its own
/// ignore-file handling stays off: it drops entries before this module sees
/// them, and an exclusion nobody can explain is the defect being fixed.
pub fn walk(root: &Path, policy: &InputPolicy) -> WalkOutcome {
    let outcome = walk_with(root, policy);
    if !outcome.files.is_empty() || !policy.has_gitignore() {
        return outcome;
    }

    // A catch-all `.gitignore` (`*` plus tracked-file whitelisting) would
    // leave nothing at all. An empty inventory is never a faithful reading of
    // a repository, so retry once without the matcher and say so.
    let generated = outcome
        .summary
        .iter()
        .find(|count| count.reason == Reason::GeneratedOutput.key())
        .map(|count| count.paths)
        .unwrap_or(0);
    if generated == 0 {
        return outcome;
    }

    let diagnostic = format!(
        "This repository's .gitignore excluded every candidate file ({generated} paths). \
         It was ignored for this scan so the workspace is not silently empty. \
         Narrow the rule, or index a directory where the source lives."
    );
    let relaxed = policy.without_gitignore(diagnostic.clone());
    let mut retried = walk_with(root, &relaxed);
    retried.gitignore_applied = false;
    // Keep any earlier complaint about the file itself: "some rules could not
    // be read" and "the rules matched everything" are separate problems.
    retried.diagnostic = Some(match &policy.gitignore_diagnostic {
        Some(existing) => format!("{existing} {diagnostic}"),
        None => diagnostic,
    });
    retried
}

fn walk_with(root: &Path, policy: &InputPolicy) -> WalkOutcome {
    // Stamped once, before anything is observed, so a file written during the
    // walk is compared against a moment that is definitely earlier than its own
    // modification time. Taking it per file would let a slow walk decide that a
    // file modified after it started had settled.
    let started_secs = crate::freshness::now_secs();
    let collector = Arc::new(Mutex::new(Collector::default()));
    // The walker's closures must be `'static`, so the borrow cannot travel.
    // Compile the matcher once and share it rather than rebuilding per entry.
    let shared = Arc::new(policy.clone());

    let mut builder = WalkBuilder::new(root);
    let filter_policy = Arc::clone(&shared);
    let filter_collector = Arc::clone(&collector);
    let filter_root = root.to_path_buf();
    builder
        .hidden(false) // The policy's own rule is more precise (.github).
        // `.ignore`, the global gitignore and `$GIT_DIR/info/exclude` are all
        // per-user or per-clone. Two people scanning the same commit must see
        // the same repository, so only the committed `.gitignore` decides, and
        // the policy consults it directly.
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .threads(std::thread::available_parallelism().map_or(4, |n| n.get()))
        .filter_entry(move |entry| {
            if !entry.file_type().is_some_and(|t| t.is_dir()) {
                return true; // Files are decided in the visitor, with their bytes.
            }
            let Some(path) = relative_path(&filter_root, entry.path()) else {
                return true;
            };
            let decision = filter_policy.decide(&path, EntryKind::Directory);
            if decision.included() {
                return true;
            }
            if let Ok(mut collector) = filter_collector.lock() {
                collector.record(&path, true, &decision);
            }
            false
        });

    let (sender, receiver) = std::sync::mpsc::channel::<Scanned>();

    builder.build_parallel().run(|| {
        let sender = sender.clone();
        let root = root.to_path_buf();
        let policy = Arc::clone(&shared);
        let collector = Arc::clone(&collector);
        Box::new(move |result| {
            let Ok(entry) = result else {
                return ignore::WalkState::Continue;
            };
            // Symlinks and other non-regular entries. The walker does not
            // follow them — a link out of the repository is not repository
            // content, and one back into it would index the target twice — but
            // silently vanishing is what this module exists to stop.
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                if entry.file_type().is_some_and(|t| t.is_symlink()) {
                    if let Some(path) = relative_path(&root, entry.path()) {
                        let decision =
                            policy.unreadable(&path, "symbolic links are not followed");
                        if let Ok(mut collector) = collector.lock() {
                            collector.record(&path, false, &decision);
                        }
                    }
                }
                return ignore::WalkState::Continue;
            }

            let Some(path) = relative_path(&root, entry.path()) else {
                return ignore::WalkState::Continue;
            };

            // Each step either keeps the file or produces the decision that
            // dropped it, so no path leaves the walk unexplained.
            let rejected = match policy.decide(&path, EntryKind::File) {
                decision if !decision.included() => Err(decision),
                decision => match entry.metadata() {
                    Err(error) => Err(policy.unreadable(&path, error.to_string())),
                    // Size is decided from metadata, before the read: one very
                    // large file must not allocate its whole length in every
                    // parallel worker that reaches it.
                    Ok(metadata) => match policy.decide_size(&path, metadata.len()) {
                        Some(rejected) => Err(rejected),
                        None => match std::fs::read(entry.path()) {
                            Err(error) => Err(policy.unreadable(&path, error.to_string())),
                            Ok(bytes) => match policy.decide_content(&path, &bytes) {
                                Some(rejected) => Err(rejected),
                                None => Ok((decision, metadata, bytes)),
                            },
                        },
                    },
                },
            };

            let (decision, metadata, bytes) = match rejected {
                Ok(kept) => kept,
                Err(decision) => {
                    if let Ok(mut collector) = collector.lock() {
                        collector.record(&path, false, &decision);
                    }
                    return ignore::WalkState::Continue;
                }
            };

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

            if let Ok(mut collector) = collector.lock() {
                collector.count(&decision);
            }

            let _ = sender.send(Scanned {
                path,
                lang: decision.language,
                loc,
                bytes: metadata.len() as u32,
                content_sha,
                is_test: decision.is_test,
                parseable: decision.parseable(),
                stat_key: crate::freshness::stat_key(&metadata, started_secs),
                content,
            });
            ignore::WalkState::Continue
        })
    });

    drop(sender);
    let mut files: Vec<Scanned> = receiver.into_iter().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    // Take the contents rather than unwrapping the Arc: the builder still owns
    // the filter closure, so a strong reference outlives the walk and
    // `try_unwrap` would fail — silently returning an empty exclusion set,
    // which is the exact unexplained-skip this module exists to remove.
    let collected = {
        let mut guard = collector
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *guard)
    };
    let (mut excluded, summary) = collected.finish();
    excluded.sort_by(|a, b| a.path.cmp(&b.path));

    WalkOutcome {
        files,
        excluded,
        summary,
        diagnostic: policy.gitignore_diagnostic.clone(),
        gitignore_applied: policy.has_gitignore(),
    }
}

#[cfg(test)]
mod tests {
    use super::walk;
    use crate::input_policy::{EntryKind, InputPolicy};
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("sdlc-walk-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    #[test]
    fn a_committed_gitignore_decides_the_map_and_a_dot_ignore_does_not() {
        let root = fixture_root("ignore");
        fs::create_dir_all(root.join(".codex")).expect("create agent config directory");
        fs::create_dir_all(root.join(".hidden")).expect("create hidden directory");
        fs::write(root.join(".ignore"), "ignored.ts\n").expect("write ignore file");
        fs::write(root.join(".gitignore"), "generated.ts\n").expect("write gitignore");
        fs::write(root.join("ignored.ts"), "export const kept = true;\n").expect("write source");
        fs::write(root.join("generated.ts"), "export const built = true;\n").expect("write built");
        fs::write(root.join(".codex/config.toml"), "model = 'fixture'\n")
            .expect("write agent config");
        fs::write(root.join(".hidden/config.toml"), "secret = true\n")
            .expect("write hidden config");

        let policy = InputPolicy::for_root(&root);
        let outcome = walk(&root, &policy);
        let paths: HashSet<String> = outcome.files.iter().map(|f| f.path.clone()).collect();

        assert!(paths.contains("ignored.ts"));
        assert!(!paths.contains("generated.ts"));
        assert!(!paths.contains(".codex/config.toml"));
        assert!(!paths.contains(".hidden/config.toml"));

        let generated = outcome
            .excluded
            .iter()
            .find(|entry| entry.path == "generated.ts")
            .expect("the generated file is recorded, not silently dropped");
        assert_eq!(generated.reason, "generated_output");
        assert!(generated.detail.contains("generated.ts"));

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_pruned_directory_is_one_decision_not_one_per_file() {
        let root = fixture_root("pruned");
        let nested = root.join("node_modules").join("pkg").join("deep");
        fs::create_dir_all(&nested).expect("create nested dependency");
        for index in 0..25 {
            fs::write(nested.join(format!("m{index}.ts")), "export {};\n").expect("write module");
        }
        fs::write(root.join("app.ts"), "export const app = 1;\n").expect("write source");

        let policy = InputPolicy::for_root(&root);
        let outcome = walk(&root, &policy);

        assert_eq!(outcome.files.len(), 1);
        let recorded: Vec<&str> = outcome
            .excluded
            .iter()
            .filter(|entry| entry.reason == "ignored_directory")
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(recorded, vec!["node_modules"]);

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn every_walked_file_is_a_path_the_policy_would_include() {
        // The executable form of "full scans and watch refreshes share one
        // policy": whatever the walk keeps, the watcher's question agrees with.
        let root = fixture_root("parity");
        fs::create_dir_all(root.join("src")).expect("create source directory");
        fs::create_dir_all(root.join("release/App.app/Contents")).expect("create bundle");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("create dependency");
        fs::write(root.join(".gitignore"), "release/\n").expect("write gitignore");
        fs::write(root.join("src/app.ts"), "export const app = 1;\n").expect("write source");
        fs::write(root.join(".mcp.json"), "{}\n").expect("write root dotfile");
        fs::write(root.join("package-lock.json"), "{}\n").expect("write lockfile");
        fs::write(root.join("release/App.app/Contents/preload.cjs"), "//\n").expect("write bundle");
        fs::write(root.join("node_modules/pkg/index.ts"), "export {};\n").expect("write dep");

        let policy = InputPolicy::for_root(&root);
        let outcome = walk(&root, &policy);

        for file in &outcome.files {
            assert!(
                policy.decide(&file.path, EntryKind::File).included(),
                "{} was walked but the shared policy excludes it",
                file.path
            );
        }
        let paths: HashSet<String> = outcome.files.iter().map(|f| f.path.clone()).collect();
        assert!(paths.contains("src/app.ts"));
        assert!(paths.contains(".mcp.json"));
        assert!(paths.contains("package-lock.json"));
        assert!(!paths.contains("release/App.app/Contents/preload.cjs"));
        assert!(!paths.contains("node_modules/pkg/index.ts"));

        // Lockfiles are inventory but never evidence.
        let lock = outcome
            .files
            .iter()
            .find(|file| file.path == "package-lock.json")
            .expect("lockfile is indexed");
        assert!(!lock.parseable);

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_catch_all_gitignore_does_not_produce_an_empty_inventory() {
        let root = fixture_root("catch-all");
        fs::write(root.join(".gitignore"), "*\n").expect("write gitignore");
        fs::write(root.join("app.ts"), "export const app = 1;\n").expect("write source");

        let policy = InputPolicy::for_root(&root);
        let outcome = walk(&root, &policy);

        assert_eq!(outcome.files.len(), 1);
        assert!(
            outcome
                .diagnostic
                .as_deref()
                .is_some_and(|text| text.contains(".gitignore")),
            "the dropped rule has to be reported, not silently applied"
        );

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn oversized_and_binary_files_say_which_rule_dropped_them() {
        let root = fixture_root("content");
        fs::create_dir_all(root.join("src")).expect("create source directory");
        fs::write(root.join("src/big.ts"), "x".repeat(3 * 1024 * 1024)).expect("write large");
        fs::write(root.join("src/logo.ts"), b"abc\0def").expect("write binary");
        fs::write(root.join("src/app.ts"), "export const app = 1;\n").expect("write source");

        let policy = InputPolicy::for_root(&root);
        let outcome = walk(&root, &policy);

        assert_eq!(outcome.files.len(), 1);
        let reasons: HashSet<&str> = outcome
            .excluded
            .iter()
            .map(|entry| entry.reason)
            .collect();
        assert!(reasons.contains("too_large"));
        assert!(reasons.contains("binary_content"));

        fs::remove_dir_all(root).expect("remove fixture");
    }
}
