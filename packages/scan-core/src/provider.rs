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
use std::path::Path;

// Protobuf decoding materializes substantially more than the serialized file.
// Keep this conservative until ingestion becomes streaming/incremental.
const MAX_SCIP_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DOCUMENT_SAMPLE: usize = 20;

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

#[cfg(test)]
mod tests {
    use super::summarize;
    use scip::types::{Document, Index, Occurrence, SymbolRole};

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
}
