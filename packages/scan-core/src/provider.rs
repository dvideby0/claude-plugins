//! Bounded ingestion of indexes produced by external SCIP providers.
//!
//! The provider owns language semantics; SDLC owns safe local execution,
//! provenance, comparison, and presentation. Parsing uses SCIP's official Rust
//! bindings instead of maintaining a second protobuf implementation.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use protobuf::Message;
use scip::types::{Index, SymbolRole};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, Path};

// Protobuf decoding materializes substantially more than the serialized file.
// Keep this conservative until ingestion becomes streaming/incremental.
const MAX_SCIP_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DOCUMENT_SAMPLE: usize = 20;
const MAX_SNAPSHOT_FILES: usize = 100_000;
const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024 * 1024;

#[napi(object)]
pub struct NativeScipDocument {
    pub path: String,
    pub occurrences: u32,
    pub definitions: u32,
    pub imports: u32,
    pub references: u32,
}

#[napi(object)]
pub struct NativeScipSummary {
    pub tool_name: String,
    pub tool_version: String,
    pub project_root: String,
    pub documents: u32,
    pub occurrences: u32,
    pub definitions: u32,
    pub imports: u32,
    pub references: u32,
    pub relationships: u32,
    pub external_symbols: u32,
    pub bytes: u32,
    pub sha256: String,
    pub sample_documents: Vec<NativeScipDocument>,
}

#[napi(object)]
pub struct NativeStagedSnapshot {
    pub source_signature: String,
    pub files: u32,
    pub bytes: u32,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeSnapshotEntry {
    pub path: String,
    pub bytes: u32,
    pub sha256: String,
}

#[napi(object)]
pub struct NativeSnapshotManifest {
    pub input_signature: String,
    pub files: u32,
    pub bytes: u32,
    pub entries: Vec<NativeSnapshotEntry>,
}

fn bounded(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn roles(roles: i32) -> (bool, bool) {
    (
        roles & SymbolRole::Definition as i32 != 0,
        roles & SymbolRole::Import as i32 != 0,
    )
}

fn summarize(index: &Index, bytes: &[u8]) -> NativeScipSummary {
    let metadata = index.metadata.as_ref();
    let tool = metadata.and_then(|item| item.tool_info.as_ref());
    let mut occurrences = 0usize;
    let mut definitions = 0usize;
    let mut imports = 0usize;
    let mut references = 0usize;
    let mut relationships = 0usize;
    let mut external_symbols = 0usize;
    let mut seen_external_symbols = HashSet::new();
    for symbol in &index.external_symbols {
        if !seen_external_symbols.insert(symbol.symbol.as_str()) {
            continue;
        }
        external_symbols += 1;
        relationships += symbol.relationships.len();
    }
    let mut sample_documents = Vec::new();
    let mut seen_documents = HashSet::new();

    for document in &index.documents {
        // scip-typescript accepts multiple project configs and follows project
        // references itself. Overlapping configs can therefore serialize the
        // same source document more than once. Preserve the official artifact,
        // but keep comparison aggregates file-based like the deterministic
        // baseline rather than inflating every count.
        if !seen_documents.insert(document.relative_path.as_str()) {
            continue;
        }
        let mut document_definitions = 0usize;
        let mut document_imports = 0usize;
        let mut document_references = 0usize;
        for occurrence in &document.occurrences {
            let (definition, import) = roles(occurrence.symbol_roles);
            if definition {
                document_definitions += 1;
            } else if import {
                document_imports += 1;
            } else if !occurrence.symbol.is_empty() {
                // SCIP may include syntax-only occurrences with no symbol.
                // Those are useful highlights, not semantic references.
                document_references += 1;
            }
        }
        occurrences += document.occurrences.len();
        definitions += document_definitions;
        imports += document_imports;
        references += document_references;
        relationships += document
            .symbols
            .iter()
            .map(|symbol| symbol.relationships.len())
            .sum::<usize>();

        if sample_documents.len() < MAX_DOCUMENT_SAMPLE {
            sample_documents.push(NativeScipDocument {
                path: document.relative_path.clone(),
                occurrences: bounded(document.occurrences.len()),
                definitions: bounded(document_definitions),
                imports: bounded(document_imports),
                references: bounded(document_references),
            });
        }
    }

    NativeScipSummary {
        tool_name: tool.map(|item| item.name.clone()).unwrap_or_default(),
        tool_version: tool.map(|item| item.version.clone()).unwrap_or_default(),
        project_root: metadata
            .map(|item| item.project_root.clone())
            .unwrap_or_default(),
        documents: bounded(seen_documents.len()),
        occurrences: bounded(occurrences),
        definitions: bounded(definitions),
        imports: bounded(imports),
        references: bounded(references),
        relationships: bounded(relationships),
        external_symbols: bounded(external_symbols),
        bytes: bounded(bytes.len()),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        sample_documents,
    }
}

fn inspect_sync(path: &str) -> Result<NativeScipSummary> {
    let path = Path::new(path);
    let metadata = std::fs::metadata(path).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Cannot inspect SCIP index {}: {error}", path.display()),
        )
    })?;
    if !metadata.is_file() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("SCIP index is not a regular file: {}", path.display()),
        ));
    }
    if metadata.len() > MAX_SCIP_BYTES {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "SCIP index is {} bytes; the safe evaluation limit is {MAX_SCIP_BYTES}",
                metadata.len()
            ),
        ));
    }

    let bytes = std::fs::read(path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Could not read SCIP index {}: {error}", path.display()),
        )
    })?;
    let index = Index::parse_from_bytes(&bytes).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid SCIP index {}: {error}", path.display()),
        )
    })?;
    Ok(summarize(&index, &bytes))
}

fn source_signature(files: &[crate::walk::Scanned]) -> String {
    let mut hash = Sha256::new();
    for file in files {
        hash.update(file.path.as_bytes());
        hash.update([0]);
        hash.update(file.content_sha.as_bytes());
        hash.update(b"\n");
    }
    format!("{:x}", hash.finalize())
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn stage_source_sync(
    root: &str,
    destination: &str,
    expected_signature: &str,
) -> Result<NativeStagedSnapshot> {
    let root = Path::new(root);
    let destination = Path::new(destination);
    if !root.is_dir() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Not a directory: {}", root.display()),
        ));
    }
    if destination.exists() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Snapshot destination already exists: {}",
                destination.display()
            ),
        ));
    }

    let files = crate::walk::walk(root);
    let signature = source_signature(&files);
    if signature != expected_signature {
        return Err(Error::new(
            Status::GenericFailure,
            "The source changed after it was indexed. Refresh the index before evaluating SCIP."
                .to_string(),
        ));
    }
    if files.len() > MAX_SNAPSHOT_FILES {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "The source snapshot contains {} files; the safety limit is {MAX_SNAPSHOT_FILES}.",
                files.len()
            ),
        ));
    }
    let total_bytes = files
        .iter()
        .try_fold(0u64, |total, file| {
            total.checked_add(file.content.len() as u64)
        })
        .ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "Snapshot size overflow.".to_string(),
            )
        })?;
    if total_bytes > MAX_SNAPSHOT_BYTES {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "The source snapshot is {total_bytes} bytes; the safety limit is {MAX_SNAPSHOT_BYTES}."
            ),
        ));
    }

    std::fs::create_dir(destination).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Could not create provider snapshot {}: {error}",
                destination.display()
            ),
        )
    })?;

    let staged = (|| -> std::io::Result<()> {
        for file in &files {
            if !safe_relative(&file.path) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Unsafe source path in snapshot: {}", file.path),
                ));
            }
            let target = destination.join(&file.path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?;
            output.write_all(file.content.as_bytes())?;
        }
        Ok(())
    })();
    if let Err(error) = staged {
        let _ = std::fs::remove_dir_all(destination);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Could not stage provider inputs: {error}"),
        ));
    }

    Ok(NativeStagedSnapshot {
        source_signature: signature,
        files: bounded(files.len()),
        bytes: bounded(total_bytes as usize),
    })
}

fn collect_snapshot_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<NativeSnapshotEntry>,
    total_bytes: &mut u64,
) -> std::io::Result<()> {
    let mut children = std::fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(std::fs::DirEntry::file_name);
    for child in children {
        let path = child.path();
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Provider snapshot contains a symlink: {}", path.display()),
            ));
        }
        if metadata.is_dir() {
            collect_snapshot_entries(root, &path, entries, total_bytes)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "Provider snapshot contains a non-file input: {}",
                    path.display()
                ),
            ));
        }
        *total_bytes = total_bytes.checked_add(metadata.len()).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "Snapshot size overflow")
        })?;
        if *total_bytes > MAX_SNAPSHOT_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Provider snapshot exceeds {MAX_SNAPSHOT_BYTES} bytes"),
            ));
        }
        if entries.len() >= MAX_SNAPSHOT_FILES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Provider snapshot exceeds {MAX_SNAPSHOT_FILES} files"),
            ));
        }
        let bytes = std::fs::read(&path)?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Snapshot path escaped its root: {}", path.display()),
                )
            })?
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(NativeSnapshotEntry {
            path: relative,
            bytes: bounded(bytes.len()),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        });
    }
    Ok(())
}

fn snapshot_manifest_sync(root: &str) -> Result<NativeSnapshotManifest> {
    let root = Path::new(root);
    if !root.is_dir() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Not a provider snapshot directory: {}", root.display()),
        ));
    }
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    collect_snapshot_entries(root, root, &mut entries, &mut total_bytes).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Could not inspect provider snapshot: {error}"),
        )
    })?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));

    let mut hash = Sha256::new();
    for entry in &entries {
        hash.update(entry.path.as_bytes());
        hash.update([0]);
        hash.update(entry.sha256.as_bytes());
        hash.update(b"\n");
    }
    Ok(NativeSnapshotManifest {
        input_signature: format!("{:x}", hash.finalize()),
        files: bounded(entries.len()),
        bytes: bounded(total_bytes as usize),
        entries,
    })
}

pub struct InspectScipTask {
    path: String,
}

#[napi]
impl Task for InspectScipTask {
    type Output = NativeScipSummary;
    type JsValue = NativeScipSummary;

    fn compute(&mut self) -> Result<Self::Output> {
        inspect_sync(&self.path)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Decode and summarize a SCIP protobuf without blocking the Node event loop.
#[napi(ts_return_type = "Promise<NativeScipSummary>")]
pub fn inspect_scip(path: String) -> Result<AsyncTask<InspectScipTask>> {
    Ok(AsyncTask::new(InspectScipTask { path }))
}

pub struct StageSourceSnapshotTask {
    root: String,
    destination: String,
    expected_signature: String,
}

#[napi]
impl Task for StageSourceSnapshotTask {
    type Output = NativeStagedSnapshot;
    type JsValue = NativeStagedSnapshot;

    fn compute(&mut self) -> Result<Self::Output> {
        stage_source_sync(&self.root, &self.destination, &self.expected_signature)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Copy the indexed source inventory into a private, immutable-for-the-run view.
#[napi(ts_return_type = "Promise<NativeStagedSnapshot>")]
pub fn stage_source_snapshot(
    root: String,
    destination: String,
    expected_signature: String,
) -> Result<AsyncTask<StageSourceSnapshotTask>> {
    Ok(AsyncTask::new(StageSourceSnapshotTask {
        root,
        destination,
        expected_signature,
    }))
}

pub struct SnapshotManifestTask {
    root: String,
}

#[napi]
impl Task for SnapshotManifestTask {
    type Output = NativeSnapshotManifest;
    type JsValue = NativeSnapshotManifest;

    fn compute(&mut self) -> Result<Self::Output> {
        snapshot_manifest_sync(&self.root)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Hash every staged provider input before and after execution.
#[napi(ts_return_type = "Promise<NativeSnapshotManifest>")]
pub fn snapshot_manifest(root: String) -> Result<AsyncTask<SnapshotManifestTask>> {
    Ok(AsyncTask::new(SnapshotManifestTask { root }))
}

#[cfg(test)]
mod tests {
    use super::{snapshot_manifest_sync, source_signature, stage_source_sync, summarize};
    use scip::types::{Document, Index, Occurrence, SymbolRole};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "sdlc-provider-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn separates_definition_import_and_reference_occurrences() {
        let mut index = Index::new();
        let mut document = Document::new();
        document.relative_path = "src/main.ts".to_string();

        let mut definition = Occurrence::new();
        definition.symbol = "scip-typescript npm fixture 0.1.0 main/definition.".to_string();
        definition.symbol_roles = SymbolRole::Definition as i32;
        let mut import = Occurrence::new();
        import.symbol = "scip-typescript npm fixture 0.1.0 store/Store#".to_string();
        import.symbol_roles = SymbolRole::Import as i32;
        let mut reference = Occurrence::new();
        reference.symbol = "scip-typescript npm fixture 0.1.0 store/Store#run().".to_string();
        let syntax_only = Occurrence::new();
        document.occurrences = vec![definition, import, reference, syntax_only];
        index.documents.push(document.clone());
        index.documents.push(document);

        let summary = summarize(&index, b"fixture");
        assert_eq!(summary.documents, 1);
        assert_eq!(summary.occurrences, 4);
        assert_eq!(summary.definitions, 1);
        assert_eq!(summary.imports, 1);
        assert_eq!(summary.references, 1);
        assert_eq!(summary.sample_documents.len(), 1);
        assert_eq!(summary.sample_documents[0].path, "src/main.ts");
    }

    #[test]
    fn stages_and_detects_provider_input_mutation() {
        let root = fixture("source");
        let snapshot = fixture("snapshot");
        fs::create_dir_all(root.join("src")).expect("create source fixture");
        fs::write(root.join("src/main.ts"), "export const value = 1;\n")
            .expect("write source fixture");

        let walked = crate::walk::walk(&root);
        let signature = source_signature(&walked);
        let staged = stage_source_sync(
            root.to_str().expect("utf8 root"),
            snapshot.to_str().expect("utf8 snapshot"),
            &signature,
        )
        .expect("stage source");
        assert_eq!(staged.files, 1);

        let before = snapshot_manifest_sync(snapshot.to_str().expect("utf8 snapshot"))
            .expect("manifest before");
        fs::write(snapshot.join("src/main.ts"), "export const value = 2;\n")
            .expect("mutate staged source");
        let after = snapshot_manifest_sync(snapshot.to_str().expect("utf8 snapshot"))
            .expect("manifest after");
        assert_ne!(before.input_signature, after.input_signature);

        fs::remove_dir_all(root).expect("remove source fixture");
        fs::remove_dir_all(snapshot).expect("remove snapshot fixture");
    }

    #[test]
    fn refuses_to_stage_a_source_generation_that_no_longer_matches() {
        let root = fixture("mismatch-source");
        let snapshot = fixture("mismatch-snapshot");
        fs::create_dir_all(&root).expect("create source fixture");
        fs::write(root.join("main.ts"), "export const value = 1;\n").expect("write source fixture");

        let error = stage_source_sync(
            root.to_str().expect("utf8 root"),
            snapshot.to_str().expect("utf8 snapshot"),
            "not-the-current-signature",
        )
        .err()
        .expect("mismatched generation must fail");
        assert!(error.reason.contains("Refresh the index"));
        assert!(!snapshot.exists());

        fs::remove_dir_all(root).expect("remove source fixture");
    }
}
