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

use crate::freshness::FileBaseline;
use crate::input_policy::{Decision, EntryKind, InputPolicy, Reason, MAX_RECORDED_EXCLUSIONS};
use ignore::WalkBuilder;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
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
    /// How this entry's facts were established.
    pub freshness: Freshness,
    /// The file's text, or `None` when it was not read because the filesystem
    /// said it had not changed. An `Option` rather than an empty string so a
    /// skipped file cannot be mistaken for an empty one anywhere downstream.
    pub content: Option<String>,
}

/// How one walked file's facts came to be believed.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    /// The bytes were read and hashed on this walk.
    Read,
    /// The filesystem's identity matched the baseline, so the read was skipped.
    Verified,
    /// The read could have been skipped and was made anyway, to check that the
    /// identity still agrees with the contents.
    Sampled,
}

impl Freshness {
    pub fn key(self) -> &'static str {
        match self {
            Freshness::Read => "read",
            Freshness::Verified => "verified",
            Freshness::Sampled => "sampled",
        }
    }
}

/// Whether a walk may trust a previous scan's record of a file.
///
/// An explicit choice at every call site rather than a default, because the
/// wrong one is silent: an analyzer that needs the file's text would receive
/// `None` and simply find nothing in it. Search, provider staging and the
/// content analyzers all say [`WalkMode::ReadAll`] for that reason.
pub enum WalkMode<'a> {
    ReadAll,
    Incremental(&'a FileBaseline),
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
    /// What the walk read, what it took the filesystem's word for, and what it
    /// checked. Reported so a fast path is never an unexplained one.
    pub freshness: FreshnessSummary,
}

#[derive(Default, Clone)]
pub struct FreshnessSummary {
    pub read: u32,
    pub verified: u32,
    pub sampled: u32,
    /// Files whose recorded identity matched while their contents did not, and
    /// whose identity was still the same when checked again straight after.
    /// Any at all means the key cannot be trusted on this filesystem.
    pub mismatches: u32,
    /// Sampled files that were written between the stat and the read. Ordinary
    /// timing against a live editor, not evidence of anything.
    pub raced: u32,
}

/// Per-walk freshness tallies, incremented from the walker's threads.
#[derive(Default)]
struct Counts {
    read: AtomicU32,
    verified: AtomicU32,
    sampled: AtomicU32,
    mismatches: AtomicU32,
    /// Sampled files that changed between the stat and the read. Counted apart
    /// from a mismatch because the key was not wrong about anything.
    raced: AtomicU32,
}

impl Counts {
    fn summary(&self) -> FreshnessSummary {
        FreshnessSummary {
            read: self.read.load(Ordering::Relaxed),
            verified: self.verified.load(Ordering::Relaxed),
            sampled: self.sampled.load(Ordering::Relaxed),
            mismatches: self.mismatches.load(Ordering::Relaxed),
            raced: self.raced.load(Ordering::Relaxed),
        }
    }
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

/// Walk the repository, reading every indexable file the mode does not excuse.
///
/// The `ignore` crate walks directories on a thread pool, which is where most
/// of the gain over a sequential readdir comes from on a large tree. Its own
/// ignore-file handling stays off: it drops entries before this module sees
/// them, and an exclusion nobody can explain is the defect being fixed.
///
/// Every path is still visited and still stat'ed, whatever the mode — that is
/// how a deletion is noticed. What [`WalkMode::Incremental`] saves is the read,
/// the UTF-8 decode, the content hash and, downstream, the parse.
pub fn walk(root: &Path, policy: &InputPolicy, mode: WalkMode<'_>) -> WalkOutcome {
    let outcome = inventory(root, policy, &mode);

    // The sample caught the key claiming a file was unchanged when its contents
    // had moved. Every other skip this run rests on the same assumption, so the
    // run is redone reading everything rather than kept with a warning attached
    // — a correct answer now, and a diagnostic saying why it cost more.
    //
    // Checked here, around the whole inventory, rather than inside it: the
    // empty-repository retry samples too, and a lie caught only on that path
    // would otherwise flow straight out with the skips it had just disproved.
    if outcome.freshness.mismatches == 0 {
        return outcome;
    }

    let missed = outcome.freshness.mismatches;
    let earlier = outcome.diagnostic.clone();
    let raced = outcome.freshness.raced;
    let mut reread = inventory(root, policy, &WalkMode::ReadAll);
    // Carried across, both of them: the ReadAll pass does no sampling, so its
    // own counts for these are structurally zero and would erase what the first
    // pass actually found.
    reread.freshness.mismatches = missed;
    reread.freshness.raced = raced;
    let note = format!(
        "The filesystem's identity for {missed} file(s) matched while their contents had \
         changed, so nothing this filesystem reports about a file being unchanged can be \
         relied on. Every file was read for this scan, and this workspace will keep reading \
         every file until a full rescan is asked for, which clears it — and which \
         re-establishes it on the next scan if the check fails again."
    );
    // Whatever the first pass had to say about the input policy is a separate
    // problem from the key being wrong, and is not dropped for this scan.
    reread.diagnostic = Some(match earlier {
        Some(existing) => format!("{existing} {note}"),
        None => note,
    });
    reread
}

/// Whether a failed read means the file is gone, rather than momentarily out of
/// reach.
///
/// Listed the other way round on purpose. The recoverable set cannot be
/// enumerated: the Windows sharing violation an antivirus or an editor produces
/// — the exact case the sampled-read fallback exists for — reaches Rust as
/// `Uncategorized`, which cannot even be named on stable. Naming the kinds that
/// mean absence and treating everything else as "still there, try again later"
/// keeps the fallback working on the platform that needs it.
///
/// It is a best effort at the thing that must not happen, not a guarantee of
/// it. A deletion can surface as something else — on Windows, delete-pending
/// semantics report access denied — and such a file keeps its facts for one
/// scan before the ordinary not-walked path removes it. That is the direction
/// to be wrong in: a file briefly kept is repaired by the next scan, while a
/// file wrongly dropped loses its symbols, edges and findings immediately.
fn read_failure_is_absence(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::IsADirectory
            | std::io::ErrorKind::NotADirectory
    )
}

/// Whether a sampled disagreement means the key is unreliable.
///
/// `observed` is the identity the walk stat'ed before reading; `current` is the
/// identity a moment after. Equal means the file did not move under us, so the
/// key really did stand for contents that were not there. Anything else — a
/// different identity, or none because the file has now entered the racy window
/// — means it was written between the two calls, which says nothing about the
/// filesystem and happens constantly to a scan racing an editor save.
fn key_was_wrong(observed: &Option<String>, current: &Option<String>) -> bool {
    observed == current
}

/// The walk, plus the one retry that keeps an empty inventory from standing.
fn inventory(root: &Path, policy: &InputPolicy, mode: &WalkMode<'_>) -> WalkOutcome {
    let outcome = walk_with(root, policy, mode);
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
    let mut retried = walk_with(root, &relaxed, mode);
    retried.gitignore_applied = false;
    // Keep any earlier complaint about the file itself: "some rules could not
    // be read" and "the rules matched everything" are separate problems.
    retried.diagnostic = Some(match &policy.gitignore_diagnostic {
        Some(existing) => format!("{existing} {diagnostic}"),
        None => diagnostic,
    });
    retried
}

/// Read and hash exactly the named paths, with no traversal.
///
/// For the case a walk cannot answer: a file the walk correctly skipped, which
/// something discovered *after* the walk needs rebuilt anyway. The set is known
/// only once the run knows what was deleted, so it cannot be folded into the
/// baseline; asking for those few paths by name is cheaper and clearer than
/// giving up the fast path for the whole repository.
///
/// A path the policy excludes, or that has gone, is left out rather than
/// guessed at — the caller learns which by what comes back.
pub fn read_paths(root: &Path, policy: &InputPolicy, paths: &[String]) -> Vec<Scanned> {
    let started_secs = crate::freshness::now_secs();
    paths
        .iter()
        .filter_map(|path| {
            let decision = policy.decide(path, EntryKind::File);
            if !decision.included() {
                return None;
            }
            let absolute = root.join(path);
            let metadata = std::fs::metadata(&absolute).ok()?;
            if !metadata.is_file() || policy.decide_size(path, metadata.len()).is_some() {
                return None;
            }
            let bytes = std::fs::read(&absolute).ok()?;
            if policy.decide_content(path, &bytes).is_some() {
                return None;
            }

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

            Some(Scanned {
                path: path.clone(),
                lang: decision.language,
                loc,
                bytes: metadata.len() as u32,
                content_sha,
                is_test: decision.is_test,
                parseable: decision.parseable(),
                stat_key: crate::freshness::stat_key(&metadata, started_secs),
                freshness: Freshness::Read,
                content: Some(content),
            })
        })
        .collect()
}

fn walk_with(root: &Path, policy: &InputPolicy, mode: &WalkMode<'_>) -> WalkOutcome {
    // Stamped once, before anything is observed, so a file written during the
    // walk is compared against a moment that is definitely earlier than its own
    // modification time. Taking it per file would let a slow walk decide that a
    // file modified after it started had settled.
    let started_secs = crate::freshness::now_secs();
    let collector = Arc::new(Mutex::new(Collector::default()));
    let counts = Arc::new(Counts::default());
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
        let counts = Arc::clone(&counts);
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
            // dropped it, so no path leaves the walk unexplained. The read is
            // the last step, so a file the baseline excuses never reaches it.
            let rejected = match policy.decide(&path, EntryKind::File) {
                decision if !decision.included() => Err(decision),
                decision => match entry.metadata() {
                    Err(error) => Err(policy.unreadable(&path, error.to_string())),
                    // Size is decided from metadata, before the read: one very
                    // large file must not allocate its whole length in every
                    // parallel worker that reaches it.
                    Ok(metadata) => match policy.decide_size(&path, metadata.len()) {
                        Some(rejected) => Err(rejected),
                        None => Ok((decision, metadata)),
                    },
                },
            };

            let (decision, metadata) = match rejected {
                Ok(kept) => kept,
                Err(decision) => {
                    if let Ok(mut collector) = collector.lock() {
                        collector.record(&path, false, &decision);
                    }
                    return ignore::WalkState::Continue;
                }
            };

            let stat_key = crate::freshness::stat_key(&metadata, started_secs);
            let unchanged = match mode {
                WalkMode::ReadAll => None,
                WalkMode::Incremental(baseline) => baseline.unchanged(&path, stat_key.as_deref()),
            };

            // A bounded, rotating slice of the files that could be skipped is
            // read anyway and compared. The key is evidence of identity, not of
            // content; this is what turns "we believe it still holds" into
            // something the system checks rather than assumes.
            let sample = match (&unchanged, mode) {
                (Some(_), WalkMode::Incremental(baseline)) => baseline.sampled(&path),
                _ => false,
            };
            let expected_sha = unchanged.map(|entry| (entry.content_sha.clone(), entry.loc));

            let scanned = match &expected_sha {
                // The filesystem says this is the same file we already read, so
                // its recorded facts stand. Note what is *not* carried forward:
                // the content. A caller that needs the text has to say so with
                // `WalkMode::ReadAll` rather than receive an empty string.
                Some((content_sha, loc)) if !sample => {
                    counts.verified.fetch_add(1, Ordering::Relaxed);
                    Scanned {
                        path,
                        lang: decision.language,
                        loc: *loc,
                        bytes: metadata.len() as u32,
                        content_sha: content_sha.clone(),
                        is_test: decision.is_test,
                        parseable: decision.parseable(),
                        stat_key,
                        freshness: Freshness::Verified,
                        content: None,
                    }
                }
                _ => {
                    let read = std::fs::read(entry.path());
                    // A sampled file is one we were entitled to skip. If the
                    // extra read fails on a lock — an antivirus or an editor
                    // holding the file, routine on Windows, which samples twice
                    // as many files — the file is still there and its recorded
                    // facts still stand. Dropping it would delete its symbols
                    // and retire its findings on the strength of a transient
                    // lock and a rotation coin flip.
                    //
                    // A file that is *gone*, though, really is gone, and this
                    // is the one path that would otherwise resurrect it: the
                    // walk would report it verified, and the scan would keep it
                    // present with all its facts. So the error kind decides,
                    // and only the ones that mean "still there, cannot read it
                    // right now" take the fallback.
                    let recoverable = read
                        .as_ref()
                        .err()
                        .is_some_and(|error| !read_failure_is_absence(error));
                    if let (true, Some((content_sha, loc))) = (recoverable, &expected_sha) {
                        counts.verified.fetch_add(1, Ordering::Relaxed);
                        let _ = sender.send(Scanned {
                            path: path.clone(),
                            lang: decision.language,
                            loc: *loc,
                            bytes: metadata.len() as u32,
                            content_sha: content_sha.clone(),
                            is_test: decision.is_test,
                            parseable: decision.parseable(),
                            stat_key,
                            freshness: Freshness::Verified,
                            content: None,
                        });
                        if let Ok(mut collector) = collector.lock() {
                            collector.count(&decision);
                        }
                        return ignore::WalkState::Continue;
                    }
                    let bytes = match read {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            let decision = policy.unreadable(&path, error.to_string());
                            if let Ok(mut collector) = collector.lock() {
                                collector.record(&path, false, &decision);
                            }
                            return ignore::WalkState::Continue;
                        }
                    };
                    if let Some(rejected) = policy.decide_content(&path, &bytes) {
                        if let Ok(mut collector) = collector.lock() {
                            collector.record(&path, false, &rejected);
                        }
                        return ignore::WalkState::Continue;
                    }

                    // Decode lossily so one malformed byte does not make an
                    // otherwise indexable text file disappear from the
                    // repository inventory.
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

                    let mut raced_key = false;
                    // A sampled file whose contents still match its key needs
                    // nothing rebuilt — the stored facts are correct. What the
                    // read bought is the knowledge that the key is honest. A
                    // mismatch means it is not, and the caller re-walks.
                    let held = expected_sha
                        .as_ref()
                        .is_some_and(|(expected, _)| *expected == content_sha);
                    if sample && held {
                        counts.sampled.fetch_add(1, Ordering::Relaxed);
                        Scanned {
                            path,
                            lang: decision.language,
                            loc,
                            bytes: metadata.len() as u32,
                            content_sha,
                            is_test: decision.is_test,
                            parseable: decision.parseable(),
                            stat_key,
                            freshness: Freshness::Sampled,
                            content: None,
                        }
                    } else {
                        if sample {
                            // The bytes disagree with the recorded hash, and
                            // there are two ways that happens. The filesystem's
                            // identity is unreliable — what the sample is for —
                            // or somebody wrote the file between our stat and
                            // our read a moment later, which the racy rule
                            // cannot cover because the mtime we captured was
                            // genuinely settled at the time. A watcher-driven
                            // scan races editor saves constantly, and treating
                            // that as proof of a lying filesystem would drop a
                            // workspace onto the slow path for good on the
                            // strength of ordinary timing.
                            //
                            // Re-stat to tell them apart: if the identity has
                            // moved since, or has entered the racy window, the
                            // file changed under us and nothing was disproved.
                            let now = std::fs::metadata(entry.path())
                                .ok()
                                .and_then(|fresh| crate::freshness::stat_key(&fresh, started_secs));
                            if key_was_wrong(&stat_key, &now) {
                                counts.mismatches.fetch_add(1, Ordering::Relaxed);
                            } else {
                                counts.raced.fetch_add(1, Ordering::Relaxed);
                                // The key was stat'ed before the write and the
                                // contents hashed after it, so the pair was
                                // never true at any instant. Recording it would
                                // make next scan's baseline claim those bytes
                                // for that identity — and on a platform whose
                                // key can be restored, a later mtime-preserving
                                // write could match it and skip a real change.
                                // No key: not a baseline, read it next time.
                                raced_key = true;
                            }
                        }
                        counts.read.fetch_add(1, Ordering::Relaxed);
                        Scanned {
                            path,
                            lang: decision.language,
                            loc,
                            bytes: metadata.len() as u32,
                            content_sha,
                            is_test: decision.is_test,
                            parseable: decision.parseable(),
                            // Applied here, where the flag has actually been
                            // set. A binding above the branch that decides it
                            // reads as if it works and is a dead store.
                            stat_key: if raced_key { None } else { stat_key },
                            freshness: Freshness::Read,
                            content: Some(content),
                        }
                    }
                }
            };

            if let Ok(mut collector) = collector.lock() {
                collector.count(&decision);
            }

            let _ = sender.send(scanned);
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
        freshness: counts.summary(),
    }
}

#[cfg(test)]
mod tests {
    use super::{key_was_wrong, read_failure_is_absence, walk, WalkMode};
    use crate::freshness::FileBaseline;
    use crate::input_policy::{EntryKind, InputPolicy};
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};
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

    /// A baseline that claims every file is unchanged, with the recorded
    /// content hash the caller supplies.
    fn baseline_claiming(root: &Path, policy: &InputPolicy, content_sha: &str) -> FileBaseline {
        let entries = walk(root, policy, WalkMode::ReadAll)
            .files
            .into_iter()
            .filter_map(|file| {
                Some((
                    file.path,
                    crate::freshness::BaselineEntry {
                        stat_key: file.stat_key?,
                        content_sha: content_sha.to_string(),
                        loc: file.loc,
                    },
                ))
            })
            .collect::<std::collections::HashMap<_, _>>();
        FileBaseline::new(entries, 1)
    }

    #[test]
    fn a_key_that_disagrees_with_the_contents_makes_the_walk_read_everything() {
        // The sample exists for exactly this: the recorded identity matches, so
        // the file would have been skipped, but the bytes it stands for are not
        // the bytes on disk. One demonstration is enough to stop trusting the
        // key for the whole run — every other skip rests on the same
        // assumption, so the run is redone rather than kept with a warning.
        let root = fixture_root("mismatch");
        fs::write(root.join("a.ts"), "export const a = 1;\n").expect("write");
        fs::write(root.join("b.ts"), "export const b = 2;\n").expect("write");
        // Out of the racy window, so the files are keyable at all.
        for name in ["a.ts", "b.ts"] {
            let past = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
            fs::File::options()
                .write(true)
                .open(root.join(name))
                .expect("reopen")
                .set_times(fs::FileTimes::new().set_modified(past).set_accessed(past))
                .expect("age");
        }
        let policy = InputPolicy::for_root(&root);

        let honest = baseline_claiming(&root, &policy, "");
        let outcome = walk(&root, &policy, WalkMode::Incremental(&honest));
        // Every recorded hash is wrong here, so whichever file the rotation
        // picks, the sample catches it.
        assert!(outcome.freshness.mismatches > 0);
        assert!(outcome.diagnostic.is_some_and(|note| note.contains("Every file was read")));
        // And the run that comes back is a complete one: everything read, with
        // its contents, so nothing downstream sees a half-trusted index.
        assert_eq!(outcome.freshness.verified, 0);
        assert_eq!(outcome.freshness.sampled, 0);
        assert!(outcome.files.iter().all(|file| file.content.is_some()));
    }

    #[test]
    fn only_absence_disqualifies_a_sampled_file_from_keeping_its_facts() {
        use std::io::{Error, ErrorKind};

        // A sampled file is one we were entitled to skip. A read that fails
        // because something holds the file leaves its recorded facts standing;
        // a read that fails because the file is gone must not, or the walk
        // reports it verified and the scan keeps every symbol it used to have.
        assert!(read_failure_is_absence(&Error::from(ErrorKind::NotFound)));
        assert!(read_failure_is_absence(&Error::from(ErrorKind::IsADirectory)));
        assert!(read_failure_is_absence(&Error::from(ErrorKind::NotADirectory)));

        assert!(!read_failure_is_absence(&Error::from(ErrorKind::PermissionDenied)));
        assert!(!read_failure_is_absence(&Error::from(ErrorKind::TimedOut)));

        // The one that matters most, and the reason the test is written this
        // way round. An error Rust has no mapping for arrives as
        // `Uncategorized`, which cannot be named in a `matches!` on stable — so
        // an allow-list of recoverable kinds could never have contained it. The
        // Windows sharing violation an antivirus or an editor produces, which
        // is the case the fallback exists for, is exactly such an error.
        assert!(!read_failure_is_absence(&Error::from_raw_os_error(UNMAPPED_ERRNO)));

        // Named on Windows, where it is that violation. Elsewhere 32 is EPIPE,
        // so asserting it there would pin a different error entirely — and
        // `cargo test` only runs on Linux in CI, so it would have pinned
        // nothing at all on the platform this is about.
        #[cfg(windows)]
        assert!(!read_failure_is_absence(&Error::from_raw_os_error(32)));
    }

    /// An errno with no `ErrorKind` mapping, so `kind()` is `Uncategorized`.
    /// High enough to stay unassigned on the platforms this crate builds for.
    const UNMAPPED_ERRNO: i32 = 9999;

    #[test]
    fn a_file_written_during_the_walk_is_not_evidence_that_the_key_lies() {
        // The race itself cannot be staged from outside — it needs a write to
        // land between the walk's stat and its read a moment later, and a test
        // that tried would mostly be testing its own luck. The decision the
        // walk makes when it sees a disagreement is what matters, and that is
        // a plain comparison.
        let observed = Some("abc123".to_string());

        // Same identity a moment later: the file did not move under us, so the
        // key really did stand for contents that were not there.
        assert!(key_was_wrong(&observed, &observed.clone()));

        // A different identity: written since the stat.
        assert!(!key_was_wrong(&observed, &Some("def456".to_string())));

        // No identity at all, because the file has just entered the racy
        // window — which is precisely what a write during the walk looks like.
        assert!(!key_was_wrong(&observed, &None));
    }

    #[test]
    fn a_key_that_agrees_lets_the_rest_of_the_walk_skip() {
        let root = fixture_root("agrees");
        fs::write(root.join("a.ts"), "export const a = 1;\n").expect("write");
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(root.join("a.ts"))
            .expect("reopen")
            .set_times(fs::FileTimes::new().set_modified(past).set_accessed(past))
            .expect("age");
        let policy = InputPolicy::for_root(&root);

        let read = walk(&root, &policy, WalkMode::ReadAll);
        let recorded = read.files[0].content_sha.clone();
        let honest = baseline_claiming(&root, &policy, &recorded);

        let outcome = walk(&root, &policy, WalkMode::Incremental(&honest));
        assert_eq!(outcome.freshness.mismatches, 0);
        assert_eq!(outcome.freshness.read, 0);
        // A single-file repository is always in the sample, so this is the
        // checked-and-held path rather than the skipped one — and a checked
        // file still needs no re-parse, because its stored facts are correct.
        assert_eq!(outcome.freshness.verified + outcome.freshness.sampled, 1);
        assert!(outcome.files.iter().all(|file| file.content.is_none()));
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
        let outcome = walk(&root, &policy, WalkMode::ReadAll);
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
        let outcome = walk(&root, &policy, WalkMode::ReadAll);

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
        let outcome = walk(&root, &policy, WalkMode::ReadAll);

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
        let outcome = walk(&root, &policy, WalkMode::ReadAll);

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
        let outcome = walk(&root, &policy, WalkMode::ReadAll);

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
