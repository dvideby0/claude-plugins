//! Whether a file on disk is the same file we already read.
//!
//! The walk reads and hashes every file on every scan, so a warm rescan of an
//! untouched repository does the same work as a cold one. Skipping that needs a
//! cheap answer to "is this the same bytes as last time", and the filesystem
//! already has one in the metadata the walk fetches anyway to enforce the size
//! cap.
//!
//! The key is deliberately not size plus modification time. `cp -p`, `rsync -a`,
//! `tar -xm` and restoring from a backup all preserve `mtime` while replacing
//! the contents, and those are exactly the operations somebody runs before
//! asking why the index is wrong. `ctime` moves for all of them and no userland
//! call can backdate it. `dev` and `ino` catch the other common shape,
//! save-by-rename, which is what editors and `git checkout` do — same size, same
//! mtime, different inode.
//!
//! Every component is folded into one digest and compared for equality only.
//! Nothing here orders two keys, so a clock that jumps backwards cannot make a
//! stale file look fresh; it can only make a fresh one look changed, which
//! costs a read.

use crate::signature::finish;
use sha2::{Digest, Sha256};
use std::fs::Metadata;

/// The filesystem's identity for a file, or `None` when it cannot be trusted.
///
/// `None` is not "unchanged" and is not an error — it means this observation
/// cannot serve as a baseline, so the next scan must read the file. Callers
/// store it as NULL for exactly that reason.
///
/// The racy case is decided here, at the moment of observation, rather than
/// later at comparison time. A file whose modification time is not strictly in
/// the past relative to the walk that observed it may still be being written:
/// the write could land in the same timestamp tick as our read and leave a key
/// that matches while the contents moved on. Git's index calls these entries
/// racily clean and handles them the same way. Deciding it once, on write,
/// keeps the read path a plain equality test that cannot be got wrong.
pub fn stat_key(metadata: &Metadata, walk_started_secs: i64) -> Option<String> {
    let mut hasher = Sha256::new();
    let modified_secs = platform_key(metadata, &mut hasher)?;
    if modified_secs >= walk_started_secs {
        return None;
    }
    Some(finish(hasher))
}

/// Seconds since the epoch, for stamping the start of a walk.
///
/// A clock before 1970 is not a case worth modelling; it yields a negative
/// value, every file looks racy, and every file is read.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() as i64)
}

/// Feed the platform's identity fields into the hasher and report the file's
/// modification time in seconds, which the racy rule needs.
#[cfg(unix)]
fn platform_key(metadata: &Metadata, hasher: &mut Sha256) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;

    hasher.update(b"unix\0");
    for field in [
        metadata.dev(),
        metadata.ino(),
        metadata.size(),
        metadata.mtime() as u64,
        metadata.mtime_nsec() as u64,
        // The one field userland cannot set. Without it, an archive extraction
        // or a restore that preserves mtime would read as unchanged.
        metadata.ctime() as u64,
        metadata.ctime_nsec() as u64,
    ] {
        hasher.update(field.to_le_bytes());
    }
    Some(metadata.mtime())
}

/// Windows has no `ctime` that means what Unix means by it, and `std` exposes
/// neither the volume serial number nor the file index on stable, so the two
/// strongest fields are both unavailable. What is left — size, last write time
/// and creation time — can be preserved across a content change by an archiver
/// or a restore, and NTFS tunnelling can even hand a recreated file its
/// original creation time. The key is therefore weaker here on purpose, and the
/// sampling that checks it still tells the truth is what carries the difference.
#[cfg(windows)]
fn platform_key(metadata: &Metadata, hasher: &mut Sha256) -> Option<i64> {
    use std::os::windows::fs::MetadataExt;

    hasher.update(b"windows\0");
    for field in [
        metadata.file_size(),
        metadata.last_write_time(),
        metadata.creation_time(),
        u64::from(metadata.file_attributes()),
    ] {
        hasher.update(field.to_le_bytes());
    }
    // `last_write_time` is 100ns intervals since 1601. Convert to Unix seconds
    // so the racy comparison is against the same clock everywhere.
    const INTERVALS_PER_SEC: u64 = 10_000_000;
    const EPOCH_DIFFERENCE_SECS: i64 = 11_644_473_600;
    Some((metadata.last_write_time() / INTERVALS_PER_SEC) as i64 - EPOCH_DIFFERENCE_SECS)
}

#[cfg(not(any(unix, windows)))]
fn platform_key(_metadata: &Metadata, _hasher: &mut Sha256) -> Option<i64> {
    // No key rather than a guess: the file is read on every scan, which is the
    // behaviour every platform had before this existed.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "sdlc-freshness-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        root
    }

    fn key(path: &Path, started: i64) -> Option<String> {
        stat_key(&fs::metadata(path).expect("metadata"), started)
    }

    /// The argument is when the *walk* started, so a walk that began after the
    /// file settled can trust it, and one that began before it cannot.
    const WALK_AFTER_FILE: i64 = i64::MAX;
    const WALK_BEFORE_FILE: i64 = 0;

    #[test]
    fn a_file_still_being_written_gets_no_key() {
        let root = fixture_root("racy");
        let path = root.join("a.txt");
        fs::write(&path, b"one").expect("write");

        assert!(
            key(&path, WALK_BEFORE_FILE).is_none(),
            "modified no earlier than the walk, so it could still be changing"
        );
        assert!(key(&path, WALK_AFTER_FILE).is_some());
    }

    #[test]
    fn the_key_moves_when_the_contents_do() {
        let root = fixture_root("contents");
        let path = root.join("a.txt");
        fs::write(&path, b"one").expect("write");
        let before = key(&path, WALK_AFTER_FILE).expect("key");

        // Same length, so a size-only key would call this unchanged.
        fs::write(&path, b"two").expect("rewrite");
        assert_ne!(before, key(&path, WALK_AFTER_FILE).expect("key"));
    }

    #[test]
    fn the_key_moves_when_a_replacement_preserves_the_modification_time() {
        // What `cp -p`, `rsync -a`, `tar -xm` and restoring from a backup all
        // do. Size and modification time survive; it is not the same file, and
        // a key built from those two alone would say it was.
        let root = fixture_root("preserved");
        let path = root.join("a.txt");
        fs::write(&path, b"one").expect("write");
        let original = fs::metadata(&path).expect("metadata");
        let before = stat_key(&original, WALK_AFTER_FILE).expect("key");

        let replacement = root.join("b.txt");
        fs::write(&replacement, b"two").expect("write");
        fs::rename(&replacement, &path).expect("rename over");
        fs::File::options()
            .write(true)
            .open(&path)
            .expect("reopen")
            .set_times(
                fs::FileTimes::new().set_modified(original.modified().expect("modified")),
            )
            .expect("restore modification time");

        let after = fs::metadata(&path).expect("metadata");
        assert_eq!(
            original.len(),
            after.len(),
            "the fixture only means something while the size is unchanged"
        );
        assert_eq!(
            original.modified().expect("modified"),
            after.modified().expect("modified"),
            "the fixture only means something while the modification time is unchanged"
        );
        assert_ne!(before, stat_key(&after, WALK_AFTER_FILE).expect("key"));
    }

    #[test]
    fn an_untouched_file_keeps_its_key() {
        // The whole point: this is the case that gets to skip a read.
        let root = fixture_root("stable");
        let path = root.join("a.txt");
        fs::write(&path, b"one").expect("write");

        let before = key(&path, WALK_AFTER_FILE).expect("key");
        let _ = fs::read(&path).expect("read");
        assert_eq!(before, key(&path, WALK_AFTER_FILE).expect("key"));
    }
}
