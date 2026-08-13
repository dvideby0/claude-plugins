//! Bounded ingestion of indexes produced by external SCIP providers.
//!
//! The provider owns language semantics; SDLC owns safe local execution,
//! provenance, comparison, and presentation. Parsing uses SCIP's official Rust
//! bindings instead of maintaining a second protobuf implementation.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use protobuf::Message;
use scip::types::{
    occurrence, symbol_information, Document, Index, Occurrence, PositionEncoding, Relationship,
    SymbolInformation, SymbolRole,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use url::Url;

// Protobuf decoding materializes substantially more than the serialized file.
// Keep this conservative until ingestion becomes streaming/incremental.
const MAX_SCIP_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DOCUMENT_SAMPLE: usize = 20;
const MAX_RAW_SCIP_RECORDS: usize = 500_000;
const MAX_PROJECTED_FACTS: usize = 500_000;
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
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct NativeScipRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[napi(object)]
pub struct NativeScipSourceDocument {
    pub path: String,
    pub language: String,
}

#[napi(object)]
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct NativeScipPathAlias {
    /// Lexically normalized path emitted by the provider.
    pub provider_path: String,
    /// Canonical manifest spelling observed while the staged input existed.
    pub path: String,
}

#[napi(object)]
pub struct NativeScipSymbol {
    /// Document-scoped for SCIP local symbols; global otherwise.
    pub key: String,
    pub symbol: String,
    pub display_name: String,
    pub kind: String,
    pub path: Option<String>,
    pub external: bool,
    /// Conflicting provider documents or metadata describe this identity.
    pub ambiguous: bool,
}

#[napi(object)]
pub struct NativeScipOccurrence {
    pub path: String,
    pub range: Option<NativeScipRange>,
    pub position_encoding: String,
    pub symbol_key: String,
    pub symbol: String,
    /// definition, import, reference, read, or write.
    pub kind: String,
    /// Lossless SCIP role labels for evidence/debugging.
    pub native_kind: String,
    pub ambiguous: bool,
}

#[napi(object)]
pub struct NativeScipRelationship {
    pub path: Option<String>,
    pub source_key: String,
    pub source_symbol: String,
    pub target_key: String,
    pub target_symbol: String,
    /// implement or reference in the provider-neutral vocabulary.
    pub kind: String,
    /// The exact SCIP relationship flag represented by this edge.
    pub native_kind: String,
    pub ambiguous: bool,
}

#[napi(object)]
pub struct NativeScipProjection {
    pub sha256: String,
    pub path_aliases: Vec<NativeScipPathAlias>,
    pub path_alias_signature: String,
    pub documents: Vec<NativeScipSourceDocument>,
    pub symbols: Vec<NativeScipSymbol>,
    pub occurrences: Vec<NativeScipOccurrence>,
    pub relationships: Vec<NativeScipRelationship>,
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
    pub path_aliases: Option<Vec<NativeScipPathAlias>>,
    pub path_alias_signature: Option<String>,
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

#[derive(Clone)]
struct ProjectedSymbol {
    key: String,
    symbol: String,
    display_name: String,
    kind: String,
    path: Option<String>,
    external: bool,
    has_display_name: bool,
    has_kind: bool,
    ambiguous: bool,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ProjectedOccurrence {
    path: String,
    range: Option<NativeScipRange>,
    position_encoding: String,
    symbol_key: String,
    symbol: String,
    kind: String,
    native_kind: String,
    document_ambiguous: bool,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ProjectedRelationship {
    path: Option<String>,
    source_key: String,
    source_symbol: String,
    target_key: String,
    target_symbol: String,
    kind: String,
    native_kind: String,
    ambiguous: bool,
}

#[derive(Default)]
struct ProjectionBudget {
    items: usize,
}

impl ProjectionBudget {
    fn reserve(&mut self) -> Result<()> {
        if self.items >= MAX_PROJECTED_FACTS {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "SCIP projection exceeds the evaluation limit of {MAX_PROJECTED_FACTS} unique items."
                ),
            ));
        }
        self.items += 1;
        Ok(())
    }
}

fn position_encoding(document: &Document) -> String {
    match document.position_encoding.enum_value() {
        Ok(PositionEncoding::UTF8CodeUnitOffsetFromLineStart) => "utf-8",
        Ok(PositionEncoding::UTF16CodeUnitOffsetFromLineStart) => "utf-16",
        Ok(PositionEncoding::UTF32CodeUnitOffsetFromLineStart) => "utf-32",
        _ => "unknown",
    }
    .to_string()
}

fn valid_range(
    start_line: i32,
    start_column: i32,
    end_line: i32,
    end_column: i32,
) -> Option<NativeScipRange> {
    if start_line < 0
        || start_column < 0
        || end_line < start_line
        || end_column < 0
        || (end_line == start_line && end_column < start_column)
    {
        return None;
    }
    Some(NativeScipRange {
        start_line: start_line as u32,
        start_column: start_column as u32,
        end_line: end_line as u32,
        end_column: end_column as u32,
    })
}

fn occurrence_range(item: &Occurrence) -> Option<NativeScipRange> {
    match item.typed_range.as_ref() {
        Some(occurrence::Typed_range::SingleLineRange(range)) => valid_range(
            range.line,
            range.start_character,
            range.line,
            range.end_character,
        ),
        Some(occurrence::Typed_range::MultiLineRange(range)) => valid_range(
            range.start_line,
            range.start_character,
            range.end_line,
            range.end_character,
        ),
        Some(_) => None,
        None => match item.range.as_slice() {
            [line, start, end] => valid_range(*line, *start, *line, *end),
            [start_line, start, end_line, end] => valid_range(*start_line, *start, *end_line, *end),
            _ => None,
        },
    }
}

fn has_role(roles: i32, role: SymbolRole) -> bool {
    roles & role as i32 != 0
}

fn role_labels(roles: i32) -> String {
    let known = [
        (SymbolRole::Definition, "definition"),
        (SymbolRole::Import, "import"),
        (SymbolRole::WriteAccess, "write-access"),
        (SymbolRole::ReadAccess, "read-access"),
        (SymbolRole::Generated, "generated"),
        (SymbolRole::Test, "test"),
        (SymbolRole::ForwardDefinition, "forward-definition"),
    ];
    let mut labels = known
        .iter()
        .filter_map(|(role, label)| has_role(roles, *role).then_some(*label))
        .collect::<Vec<_>>();
    let known_mask = known.iter().fold(0, |mask, (role, _)| mask | *role as i32);
    let unknown = roles & !known_mask;
    if unknown != 0 {
        labels.push("unknown-role-bits");
    }
    if labels.is_empty() {
        labels.push("reference");
    }
    labels.join(",")
}

fn occurrence_kinds(roles: i32) -> Vec<&'static str> {
    if has_role(roles, SymbolRole::Definition) || has_role(roles, SymbolRole::ForwardDefinition) {
        return vec!["definition"];
    }
    let mut kinds = Vec::new();
    if has_role(roles, SymbolRole::Import) {
        kinds.push("import");
    }
    if has_role(roles, SymbolRole::WriteAccess) {
        kinds.push("write");
    }
    if has_role(roles, SymbolRole::ReadAccess) {
        kinds.push("read");
    }
    if kinds.is_empty() {
        kinds.push("reference");
    }
    kinds
}

fn relationship_kinds(item: &Relationship) -> Vec<(&'static str, &'static str)> {
    let mut kinds = Vec::new();
    if item.is_implementation {
        kinds.push(("implement", "implementation"));
    }
    if item.is_reference {
        kinds.push(("reference", "reference"));
    }
    if item.is_type_definition {
        kinds.push(("reference", "type-definition"));
    }
    if item.is_definition {
        kinds.push(("reference", "definition"));
    }
    kinds
}

fn scoped_symbol_key(
    path: Option<&str>,
    local_scope: Option<&str>,
    symbol: &str,
) -> Result<String> {
    if scip::symbol::is_local_symbol(symbol) {
        let path = path.ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("SCIP local symbol has no owning document: {symbol}"),
            )
        })?;
        Ok(match local_scope {
            Some(scope) => format!("local\0{path}\0{scope}\0{symbol}"),
            None => format!("local\0{path}\0{symbol}"),
        })
    } else {
        Ok(format!("global\0{symbol}"))
    }
}

fn fallback_symbol_name(symbol: &str) -> String {
    scip::symbol::parse_symbol(symbol)
        .ok()
        .and_then(|parsed| parsed.descriptors.last().map(|item| item.name.clone()))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| symbol.to_string())
}

fn symbol_kind(info: Option<&SymbolInformation>) -> (String, bool) {
    let Some(info) = info else {
        return ("UnspecifiedKind".to_string(), false);
    };
    match info.kind.enum_value() {
        Ok(symbol_information::Kind::UnspecifiedKind) => ("UnspecifiedKind".to_string(), false),
        Ok(kind) => (format!("{kind:?}"), true),
        Err(value) => (format!("UnknownKind({value})"), true),
    }
}

fn upsert_symbol(
    symbols: &mut BTreeMap<String, ProjectedSymbol>,
    budget: &mut ProjectionBudget,
    path: Option<&str>,
    local_scope: Option<&str>,
    symbol: &str,
    info: Option<&SymbolInformation>,
    ambiguous: bool,
) -> Result<String> {
    let key = scoped_symbol_key(path, local_scope, symbol)?;
    let supplied_name = info
        .map(|item| item.display_name.as_str())
        .filter(|name| !name.is_empty());
    let (kind, has_kind) = symbol_kind(info);
    let incoming_path = path.map(str::to_string);
    let external = incoming_path.is_none();
    if !symbols.contains_key(&key) {
        budget.reserve()?;
    }
    let entry = symbols
        .entry(key.clone())
        .or_insert_with(|| ProjectedSymbol {
            key: key.clone(),
            symbol: symbol.to_string(),
            display_name: supplied_name
                .map(str::to_string)
                .unwrap_or_else(|| fallback_symbol_name(symbol)),
            kind: kind.clone(),
            path: incoming_path.clone(),
            external,
            has_display_name: supplied_name.is_some(),
            has_kind,
            ambiguous,
        });
    if entry.has_display_name && supplied_name.is_some_and(|name| name != entry.display_name) {
        entry.ambiguous = true;
    } else if !entry.has_display_name {
        if let Some(name) = supplied_name {
            entry.display_name = name.to_string();
            entry.has_display_name = true;
        }
    }
    if entry.has_kind && has_kind && entry.kind != kind {
        entry.ambiguous = true;
    } else if !entry.has_kind && has_kind {
        entry.kind = kind;
        entry.has_kind = true;
    }
    if entry.path.is_none() && incoming_path.is_some() {
        entry.path = incoming_path;
        entry.external = false;
    }
    entry.ambiguous |= ambiguous;
    Ok(key)
}

fn collect_relationships(
    symbols: &mut BTreeMap<String, ProjectedSymbol>,
    relationships: &mut BTreeSet<ProjectedRelationship>,
    budget: &mut ProjectionBudget,
    path: Option<&str>,
    local_scope: Option<&str>,
    source: &SymbolInformation,
    ambiguous: bool,
) -> Result<()> {
    if source.symbol.is_empty() {
        return Ok(());
    }
    let source_key = upsert_symbol(
        symbols,
        budget,
        path,
        local_scope,
        &source.symbol,
        Some(source),
        ambiguous,
    )?;
    for item in &source.relationships {
        if item.symbol.is_empty() {
            continue;
        }
        let target_path = scip::symbol::is_local_symbol(&item.symbol)
            .then_some(path)
            .flatten();
        let target_key = upsert_symbol(
            symbols,
            budget,
            target_path,
            local_scope,
            &item.symbol,
            None,
            ambiguous,
        )?;
        for (kind, native_kind) in relationship_kinds(item) {
            let projected = ProjectedRelationship {
                path: path.map(str::to_string),
                source_key: source_key.clone(),
                source_symbol: source.symbol.clone(),
                target_key: target_key.clone(),
                target_symbol: item.symbol.clone(),
                kind: kind.to_string(),
                native_kind: native_kind.to_string(),
                ambiguous,
            };
            if !relationships.contains(&projected) {
                budget.reserve()?;
                relationships.insert(projected);
            }
        }
    }
    Ok(())
}

fn file_uri_path(value: &str) -> Result<PathBuf> {
    let url = Url::parse(value).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("SCIP project root is not a valid URI: {value}: {error}"),
        )
    })?;
    if url.scheme() != "file" {
        return Err(Error::new(
            Status::InvalidArg,
            format!("SCIP project root is not a local file URI: {value}"),
        ));
    }
    // `url` owns the platform-specific file-URI conversion, including UNC
    // authorities on Windows and rejection of remote authorities on Unix.
    let path = url.to_file_path().map_err(|()| {
        Error::new(
            Status::InvalidArg,
            format!("SCIP project root is not a local file URI: {value}"),
        )
    })?;
    if !path.is_absolute() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("SCIP project root is not an absolute local path: {value}"),
        ));
    }
    Ok(path)
}

#[derive(Debug)]
struct NormalizedDocumentPath {
    provider_path: String,
    path: String,
}

struct ProjectPathContext {
    metadata_root: PathBuf,
    lexical_root: PathBuf,
    expected_source_root: PathBuf,
}

fn validate_path_aliases(aliases: &[NativeScipPathAlias]) -> Result<BTreeMap<String, String>> {
    if aliases.len() > MAX_SNAPSHOT_FILES {
        return Err(Error::new(
            Status::InvalidArg,
            format!("SCIP path aliases exceed the limit of {MAX_SNAPSHOT_FILES}."),
        ));
    }
    let mut validated = BTreeMap::new();
    for alias in aliases {
        if portable_relative(&alias.provider_path).as_deref() != Some(alias.provider_path.as_str())
            || portable_relative(&alias.path).as_deref() != Some(alias.path.as_str())
        {
            return Err(Error::new(
                Status::InvalidArg,
                "SCIP path aliases must contain safe workspace-relative paths.".to_string(),
            ));
        }
        if alias.provider_path == alias.path {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "SCIP path alias is redundant and cannot attest an identity: {}",
                    alias.provider_path
                ),
            ));
        }
        if let Some(existing) = validated.insert(alias.provider_path.clone(), alias.path.clone()) {
            if existing != alias.path {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "SCIP path aliases conflict for provider path: {}",
                        alias.provider_path
                    ),
                ));
            }
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "SCIP path aliases contain a duplicate provider path: {}",
                    alias.provider_path
                ),
            ));
        }
    }
    Ok(validated)
}

fn path_alias_signature(aliases: &BTreeMap<String, String>) -> String {
    let mut hash = Sha256::new();
    for (provider_path, path) in aliases {
        hash.update((provider_path.len() as u64).to_le_bytes());
        hash.update(provider_path.as_bytes());
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn canonicalize_with_missing(path: &Path) -> Result<PathBuf> {
    let mut existing = path;
    let mut missing = Vec::new();
    while !existing.exists() {
        let name = existing.file_name().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Provider path has no existing ancestor: {}", path.display()),
            )
        })?;
        missing.push(name.to_os_string());
        existing = existing.parent().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Provider path has no parent: {}", path.display()),
            )
        })?;
    }
    let mut canonical = std::fs::canonicalize(existing).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Could not canonicalize provider path: {error}"),
        )
    })?;
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
        }
    }
    Some(normalized)
}

#[cfg(windows)]
fn unc_authority(path: &Path) -> Option<(String, String)> {
    use std::path::Prefix;

    let Component::Prefix(prefix) = path.components().next()? else {
        return None;
    };
    match prefix.kind() {
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => Some((
            server.to_string_lossy().into_owned(),
            share.to_string_lossy().into_owned(),
        )),
        _ => None,
    }
}

#[cfg(windows)]
fn uses_windows_device_namespace(path: &Path) -> bool {
    use std::path::Prefix;

    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    matches!(prefix.kind(), Prefix::DeviceNS(_) | Prefix::Verbatim(_))
}

#[cfg(windows)]
fn validate_unc_authority(metadata_root: &Path, expected_source_root: &Path) -> Result<()> {
    // Device namespaces can encode network paths without using Prefix::UNC
    // (for example, file://./UNC/server/share becomes \\.\UNC\...). Reject
    // them before canonicalization so provider metadata cannot trigger I/O.
    if uses_windows_device_namespace(metadata_root)
        || uses_windows_device_namespace(expected_source_root)
    {
        return Err(Error::new(
            Status::InvalidArg,
            "SCIP project root uses an unsupported Windows device namespace.".to_string(),
        ));
    }
    match (
        unc_authority(metadata_root),
        unc_authority(expected_source_root),
    ) {
        (None, None) => Ok(()),
        (Some(left), Some(right))
            if left.0.eq_ignore_ascii_case(&right.0) && left.1.eq_ignore_ascii_case(&right.1) =>
        {
            Ok(())
        }
        _ => Err(Error::new(
            Status::InvalidArg,
            "SCIP project root does not match the attested UNC authority.".to_string(),
        )),
    }
}

#[cfg(not(windows))]
fn validate_unc_authority(_metadata_root: &Path, _expected_source_root: &Path) -> Result<()> {
    Ok(())
}

fn project_path_context(
    index: &Index,
    expected_source_root: Option<&Path>,
) -> Result<Option<ProjectPathContext>> {
    let Some(expected_source_root) = expected_source_root else {
        return Ok(None);
    };
    let metadata_root = index
        .metadata
        .as_ref()
        .map(|metadata| metadata.project_root.as_str())
        .filter(|root| !root.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "SCIP index has no project root for rebasing document paths".to_string(),
            )
        })?;
    let metadata_root = file_uri_path(metadata_root)?;
    // A provider-controlled UNC authority must never be dereferenced merely to
    // discover that it differs from the app-owned expected root.
    validate_unc_authority(&metadata_root, expected_source_root)?;
    let expected_source_root = canonicalize_with_missing(expected_source_root)?;
    let canonical_metadata_root = lexical_normalize(&metadata_root)
        .and_then(|root| canonicalize_with_missing(&root).ok())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "Could not canonicalize the SCIP project root.".to_string(),
            )
        })?;
    if canonical_metadata_root != expected_source_root {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "SCIP project root does not match the attested source root: {}",
                canonical_metadata_root.display()
            ),
        ));
    }
    let lexical_root = lexical_normalize(&metadata_root).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Could not normalize the SCIP project root.".to_string(),
        )
    })?;
    Ok(Some(ProjectPathContext {
        metadata_root,
        lexical_root,
        expected_source_root,
    }))
}

fn normalized_document_path(
    raw: &str,
    context: Option<&ProjectPathContext>,
    path_aliases: &BTreeMap<String, String>,
) -> Result<NormalizedDocumentPath> {
    let portable_raw = raw.replace('\\', "/");
    let Some(context) = context else {
        let provider_path = lexical_portable_relative(&portable_raw).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("SCIP document path is not safely workspace-relative: {raw}"),
            )
        })?;
        let path = path_aliases
            .get(&provider_path)
            .cloned()
            .unwrap_or_else(|| provider_path.clone());
        return Ok(NormalizedDocumentPath {
            provider_path,
            path,
        });
    };
    let resolved =
        lexical_normalize(&context.metadata_root.join(&portable_raw)).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("SCIP document path escapes the filesystem root: {raw}"),
            )
        })?;
    // Most providers emit an ordinary relative path. Some Node paths on macOS
    // spell the same root through `/var` and `/private/var`, producing a long
    // relative path that lexically exits the URI root before returning to the
    // same canonical directory. Preserve the provider spelling when it is
    // directly safe; otherwise rebase only if the lexical absolute path is
    // already under either accepted spelling of the attested root.
    let provider_path = lexical_portable_relative(&portable_raw).or_else(|| {
        resolved
            .strip_prefix(&context.lexical_root)
            .ok()
            .or_else(|| resolved.strip_prefix(&context.expected_source_root).ok())
            .and_then(|relative| portable_relative(&relative.to_string_lossy().replace('\\', "/")))
    });
    let provider_path = provider_path.ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("SCIP document path resolves outside the attested source root: {raw}"),
        )
    })?;
    let resolved = canonicalize_with_missing(&resolved)?;
    let relative = resolved
        .strip_prefix(&context.expected_source_root)
        .map_err(|_| {
            Error::new(
                Status::InvalidArg,
                format!(
                    "SCIP document path resolves outside the attested source root: {}",
                    resolved.display()
                ),
            )
        })?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    let canonical_path = portable_relative(&relative).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("SCIP document path is not safely workspace-relative: {raw}"),
        )
    })?;
    let path = path_aliases
        .get(&provider_path)
        .cloned()
        .unwrap_or(canonical_path);
    Ok(NormalizedDocumentPath {
        provider_path,
        path,
    })
}

fn raw_projection_records(index: &Index, limit: usize) -> Result<usize> {
    let mut records = index
        .documents
        .len()
        .checked_add(index.external_symbols.len())
        .ok_or_else(|| Error::new(Status::GenericFailure, "SCIP record count overflow"))?;
    for document in &index.documents {
        records = records
            .checked_add(document.symbols.len())
            .and_then(|count| count.checked_add(document.occurrences.len()))
            .and_then(|count| {
                document.symbols.iter().try_fold(count, |total, symbol| {
                    total.checked_add(symbol.relationships.len())
                })
            })
            .ok_or_else(|| Error::new(Status::GenericFailure, "SCIP record count overflow"))?;
    }
    records = index
        .external_symbols
        .iter()
        .try_fold(records, |total, symbol| {
            total.checked_add(symbol.relationships.len())
        })
        .ok_or_else(|| Error::new(Status::GenericFailure, "SCIP record count overflow"))?;
    if records > limit {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "SCIP index contains {records} raw semantic records; the evaluation limit is {limit}."
            ),
        ));
    }
    Ok(records)
}

struct DocumentVariant<'a> {
    provider_path: String,
    path: String,
    fingerprint: String,
    document: &'a Document,
}

fn document_fingerprint(document: &Document) -> Result<String> {
    let bytes = document.write_to_bytes().map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Could not fingerprint SCIP document: {error}"),
        )
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn occurrence_category(kind: &str) -> u8 {
    u8::from(kind != "definition")
}

fn mark_anchor_ambiguity(occurrences: &mut [NativeScipOccurrence]) {
    let mut anchored = occurrences
        .iter()
        .enumerate()
        .filter_map(|(index, item)| item.range.as_ref().map(|_| index))
        .collect::<Vec<_>>();
    anchored.sort_by(|left, right| {
        let left = &occurrences[*left];
        let right = &occurrences[*right];
        (
            left.path.as_str(),
            left.range.as_ref(),
            occurrence_category(&left.kind),
            left.symbol_key.as_str(),
        )
            .cmp(&(
                right.path.as_str(),
                right.range.as_ref(),
                occurrence_category(&right.kind),
                right.symbol_key.as_str(),
            ))
    });

    let mut start = 0usize;
    while start < anchored.len() {
        let first = &occurrences[anchored[start]];
        let mut end = start + 1;
        while end < anchored.len() {
            let candidate = &occurrences[anchored[end]];
            if candidate.path != first.path
                || candidate.range != first.range
                || occurrence_category(&candidate.kind) != occurrence_category(&first.kind)
            {
                break;
            }
            end += 1;
        }
        let first_symbol = occurrences[anchored[start]].symbol_key.as_str();
        let ambiguous = anchored[start + 1..end]
            .iter()
            .any(|index| occurrences[*index].symbol_key != first_symbol);
        if ambiguous {
            for index in &anchored[start..end] {
                occurrences[*index].ambiguous = true;
            }
        }
        start = end;
    }
}

fn project(
    index: &Index,
    bytes: &[u8],
    expected_source_root: Option<&Path>,
    supplied_path_aliases: &[NativeScipPathAlias],
) -> Result<NativeScipProjection> {
    raw_projection_records(index, MAX_RAW_SCIP_RECORDS)?;
    let path_aliases = validate_path_aliases(supplied_path_aliases)?;
    let path_context = project_path_context(index, expected_source_root)?;
    let mut budget = ProjectionBudget::default();
    let mut documents = BTreeMap::<String, String>::new();
    let mut symbols = BTreeMap::<String, ProjectedSymbol>::new();
    let mut occurrences = BTreeSet::<ProjectedOccurrence>::new();
    let mut relationships = BTreeSet::<ProjectedRelationship>::new();

    let mut variants = Vec::with_capacity(index.documents.len());
    for document in &index.documents {
        let normalized = normalized_document_path(
            &document.relative_path,
            path_context.as_ref(),
            &path_aliases,
        )?;
        variants.push(DocumentVariant {
            provider_path: normalized.provider_path,
            path: normalized.path,
            fingerprint: document_fingerprint(document)?,
            document,
        });
    }
    let observed_path_aliases = variants
        .iter()
        .filter(|variant| variant.provider_path != variant.path)
        .map(|variant| (variant.provider_path.clone(), variant.path.clone()))
        .collect::<BTreeMap<_, _>>();
    if observed_path_aliases.len() > MAX_SNAPSHOT_FILES {
        return Err(Error::new(
            Status::InvalidArg,
            format!("SCIP path aliases exceed the limit of {MAX_SNAPSHOT_FILES}."),
        ));
    }
    if !supplied_path_aliases.is_empty() && observed_path_aliases != path_aliases {
        return Err(Error::new(
            Status::InvalidArg,
            "SCIP path aliases do not exactly match the retained provider documents.".to_string(),
        ));
    }
    variants.sort_by(|left, right| {
        (&left.path, &left.fingerprint).cmp(&(&right.path, &right.fingerprint))
    });
    variants
        .dedup_by(|left, right| left.path == right.path && left.fingerprint == right.fingerprint);

    let mut start = 0usize;
    while start < variants.len() {
        let mut end = start + 1;
        while end < variants.len() && variants[end].path == variants[start].path {
            end += 1;
        }
        let document_ambiguous = end - start > 1;
        for variant in &variants[start..end] {
            let document = variant.document;
            let document_path = &variant.path;
            match documents.get(document_path) {
                Some(language) if language != &document.language => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!(
                            "Conflicting SCIP documents disagree on the language for {document_path}."
                        ),
                    ));
                }
                Some(_) => {}
                None => {
                    budget.reserve()?;
                    documents.insert(document_path.clone(), document.language.clone());
                }
            }
            let encoding = position_encoding(document);
            let local_scope = document_ambiguous.then_some(variant.fingerprint.as_str());

            for info in &document.symbols {
                if info.symbol.is_empty() {
                    continue;
                }
                upsert_symbol(
                    &mut symbols,
                    &mut budget,
                    Some(document_path),
                    local_scope,
                    &info.symbol,
                    Some(info),
                    document_ambiguous,
                )?;
                collect_relationships(
                    &mut symbols,
                    &mut relationships,
                    &mut budget,
                    Some(document_path),
                    local_scope,
                    info,
                    document_ambiguous,
                )?;
            }

            for item in &document.occurrences {
                if item.symbol.is_empty() {
                    continue;
                }
                let is_definition = has_role(item.symbol_roles, SymbolRole::Definition)
                    || has_role(item.symbol_roles, SymbolRole::ForwardDefinition);
                let symbol_path = (scip::symbol::is_local_symbol(&item.symbol) || is_definition)
                    .then_some(document_path.as_str());
                let symbol_key = upsert_symbol(
                    &mut symbols,
                    &mut budget,
                    symbol_path,
                    local_scope,
                    &item.symbol,
                    None,
                    document_ambiguous,
                )?;
                let range = occurrence_range(item);
                let native_kind = role_labels(item.symbol_roles);
                for kind in occurrence_kinds(item.symbol_roles) {
                    let projected = ProjectedOccurrence {
                        path: document_path.clone(),
                        range: range.clone(),
                        position_encoding: encoding.clone(),
                        symbol_key: symbol_key.clone(),
                        symbol: item.symbol.clone(),
                        kind: kind.to_string(),
                        native_kind: native_kind.clone(),
                        document_ambiguous,
                    };
                    if !occurrences.contains(&projected) {
                        budget.reserve()?;
                        occurrences.insert(projected);
                    }
                }
            }
        }
        start = end;
    }

    for info in &index.external_symbols {
        if info.symbol.is_empty() {
            continue;
        }
        upsert_symbol(
            &mut symbols,
            &mut budget,
            None,
            None,
            &info.symbol,
            Some(info),
            false,
        )?;
        collect_relationships(
            &mut symbols,
            &mut relationships,
            &mut budget,
            None,
            None,
            info,
            false,
        )?;
    }

    let mut projected_occurrences = occurrences
        .into_iter()
        .map(|item| NativeScipOccurrence {
            path: item.path,
            range: item.range,
            position_encoding: item.position_encoding,
            symbol_key: item.symbol_key,
            symbol: item.symbol,
            kind: item.kind,
            native_kind: item.native_kind,
            ambiguous: item.document_ambiguous,
        })
        .collect::<Vec<_>>();
    mark_anchor_ambiguity(&mut projected_occurrences);
    let observed_path_alias_signature = path_alias_signature(&observed_path_aliases);

    Ok(NativeScipProjection {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        path_aliases: observed_path_aliases
            .into_iter()
            .map(|(provider_path, path)| NativeScipPathAlias {
                provider_path,
                path,
            })
            .collect(),
        path_alias_signature: observed_path_alias_signature,
        documents: documents
            .into_iter()
            .map(|(path, language)| NativeScipSourceDocument { path, language })
            .collect(),
        symbols: symbols
            .into_values()
            .map(|item| NativeScipSymbol {
                key: item.key,
                symbol: item.symbol,
                display_name: item.display_name,
                kind: item.kind,
                path: item.path,
                external: item.external,
                ambiguous: item.ambiguous,
            })
            .collect(),
        occurrences: projected_occurrences,
        relationships: relationships
            .into_iter()
            .map(|item| NativeScipRelationship {
                path: item.path,
                source_key: item.source_key,
                source_symbol: item.source_symbol,
                target_key: item.target_key,
                target_symbol: item.target_symbol,
                kind: item.kind,
                native_kind: item.native_kind,
                ambiguous: item.ambiguous,
            })
            .collect(),
    })
}

fn read_index(path: &str) -> Result<(Index, Vec<u8>)> {
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
    Ok((index, bytes))
}

fn inspect_sync(path: &str) -> Result<NativeScipSummary> {
    let (index, bytes) = read_index(path)?;
    Ok(summarize(&index, &bytes))
}

fn project_sync(
    path: &str,
    expected_source_root: &str,
    path_aliases: &[NativeScipPathAlias],
) -> Result<NativeScipProjection> {
    let (index, bytes) = read_index(path)?;
    project(
        &index,
        &bytes,
        Some(Path::new(expected_source_root)),
        path_aliases,
    )
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

fn portable_relative(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let has_drive_prefix = path
        .as_bytes()
        .get(1)
        .is_some_and(|character| *character == b':');
    if path.is_empty() || path.starts_with('/') || has_drive_prefix {
        return None;
    }
    if path
        .split('/')
        .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return None;
    }
    Some(path)
}

fn lexical_portable_relative(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let has_drive_prefix = path
        .as_bytes()
        .get(1)
        .is_some_and(|character| *character == b':');
    if path.is_empty() || path.starts_with('/') || has_drive_prefix {
        return None;
    }
    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" => return None,
            "." => {}
            ".." => {
                components.pop()?;
            }
            value => components.push(value),
        }
    }
    (!components.is_empty()).then(|| components.join("/"))
}

fn safe_relative(path: &str) -> bool {
    portable_relative(path).is_some()
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

    // The same input policy the scan used. A provider staged from a different
    // file set could not be compared with the index it is meant to evaluate.
    let policy = crate::input_policy::InputPolicy::for_root(root);
    let files = crate::walk::walk(root, &policy).files;
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
        if portable_relative(&relative).as_deref() != Some(relative.as_str()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Unsafe provider snapshot path: {relative}"),
            ));
        }
        entries.push(NativeSnapshotEntry {
            path: relative,
            bytes: bounded(bytes.len()),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        });
    }
    Ok(())
}

fn snapshot_signature<'a>(entries: impl Iterator<Item = &'a NativeSnapshotEntry>) -> String {
    let mut hash = Sha256::new();
    for entry in entries {
        hash.update(entry.path.as_bytes());
        hash.update([0]);
        hash.update(entry.sha256.as_bytes());
        hash.update(b"\n");
    }
    format!("{:x}", hash.finalize())
}

fn validate_snapshot_manifest_sync(manifest: &NativeSnapshotManifest) -> Result<()> {
    if manifest.entries.len() > MAX_SNAPSHOT_FILES
        || manifest.files as usize != manifest.entries.len()
    {
        return Err(Error::new(
            Status::InvalidArg,
            "Provider input manifest file count is inconsistent or exceeds its limit.".to_string(),
        ));
    }
    let mut entries = manifest.entries.iter().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let mut total_bytes = 0u64;
    let mut previous: Option<&str> = None;
    for entry in &entries {
        if portable_relative(&entry.path).as_deref() != Some(entry.path.as_str()) {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Provider input manifest contains an unsafe path: {}",
                    entry.path
                ),
            ));
        }
        if previous == Some(entry.path.as_str()) {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Provider input manifest contains a duplicate path: {}",
                    entry.path
                ),
            ));
        }
        if entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Provider input manifest has an invalid digest for {}",
                    entry.path
                ),
            ));
        }
        total_bytes = total_bytes
            .checked_add(u64::from(entry.bytes))
            .ok_or_else(|| Error::new(Status::InvalidArg, "Provider input size overflow"))?;
        if total_bytes > MAX_SNAPSHOT_BYTES {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Provider input manifest exceeds {MAX_SNAPSHOT_BYTES} bytes"),
            ));
        }
        previous = Some(entry.path.as_str());
    }
    if total_bytes != u64::from(manifest.bytes) {
        return Err(Error::new(
            Status::InvalidArg,
            "Provider input manifest byte count is inconsistent.".to_string(),
        ));
    }
    if snapshot_signature(entries.into_iter()) != manifest.input_signature {
        return Err(Error::new(
            Status::InvalidArg,
            "Provider input manifest signature does not match its entries.".to_string(),
        ));
    }
    match (&manifest.path_aliases, &manifest.path_alias_signature) {
        (None, None) => {}
        (Some(aliases), Some(signature)) => {
            let aliases = validate_path_aliases(aliases)?;
            if path_alias_signature(&aliases) != *signature {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Provider path alias signature does not match its retained mappings."
                        .to_string(),
                ));
            }
        }
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                "Provider path aliases and their signature must be retained together.".to_string(),
            ));
        }
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

    Ok(NativeSnapshotManifest {
        input_signature: snapshot_signature(entries.iter()),
        files: bounded(entries.len()),
        bytes: bounded(total_bytes as usize),
        entries,
        path_aliases: None,
        path_alias_signature: None,
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

pub struct ProjectScipTask {
    path: String,
    expected_source_root: String,
    path_aliases: Vec<NativeScipPathAlias>,
}

#[napi]
impl Task for ProjectScipTask {
    type Output = NativeScipProjection;
    type JsValue = NativeScipProjection;

    fn compute(&mut self) -> Result<Self::Output> {
        project_sync(&self.path, &self.expected_source_root, &self.path_aliases)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Decode bounded SCIP occurrences and relationships for neutral fact shaping.
#[napi(ts_return_type = "Promise<NativeScipProjection>")]
pub fn project_scip(
    path: String,
    expected_source_root: String,
    path_aliases: Vec<NativeScipPathAlias>,
) -> Result<AsyncTask<ProjectScipTask>> {
    Ok(AsyncTask::new(ProjectScipTask {
        path,
        expected_source_root,
        path_aliases,
    }))
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

pub struct VerifySnapshotManifestTask {
    manifest: NativeSnapshotManifest,
}

#[napi]
impl Task for VerifySnapshotManifestTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<Self::Output> {
        validate_snapshot_manifest_sync(&self.manifest)?;
        Ok(true)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Recompute and validate a durable provider input manifest off the event loop.
#[napi(ts_return_type = "Promise<boolean>")]
pub fn verify_snapshot_manifest(
    manifest: NativeSnapshotManifest,
) -> Result<AsyncTask<VerifySnapshotManifestTask>> {
    Ok(AsyncTask::new(VerifySnapshotManifestTask { manifest }))
}

#[cfg(test)]
mod tests {
    use super::{
        path_alias_signature, project, raw_projection_records, snapshot_manifest_sync,
        source_signature, stage_source_sync, summarize, validate_snapshot_manifest_sync,
        NativeScipPathAlias, ProjectionBudget, MAX_PROJECTED_FACTS,
    };
    use protobuf::MessageField;
    use scip::types::{
        occurrence, symbol_information, Document, Index, Metadata, Occurrence, PositionEncoding,
        Relationship, SingleLineRange, SymbolInformation, SymbolRole,
    };
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
    fn projects_scoped_symbols_ranges_relationships_and_ambiguity() {
        let contract = "scip-typescript npm fixture 0.1.0 api/Contract#";
        let alternate = "scip-typescript npm fixture 0.1.0 api/Alternate#";
        let mut local_info = SymbolInformation::new();
        local_info.symbol = "local 0".to_string();
        local_info.display_name = "run".to_string();
        local_info.kind = symbol_information::Kind::Function.into();
        let mut implementation = Relationship::new();
        implementation.symbol = contract.to_string();
        implementation.is_implementation = true;
        local_info.relationships.push(implementation);

        let mut definition = Occurrence::new();
        definition.symbol = "local 0".to_string();
        definition.symbol_roles = SymbolRole::Definition as i32;
        definition.range = vec![0, 0, 3];

        let mut reference = Occurrence::new();
        reference.symbol = contract.to_string();
        reference.symbol_roles = SymbolRole::ReadAccess as i32;
        let mut reference_range = SingleLineRange::new();
        reference_range.line = 1;
        reference_range.start_character = 2;
        reference_range.end_character = 10;
        reference.typed_range = Some(occurrence::Typed_range::SingleLineRange(reference_range));
        let mut conflicting_reference = reference.clone();
        conflicting_reference.symbol = alternate.to_string();

        let mut first = Document::new();
        first.language = "typescript".to_string();
        first.relative_path = "src/a.ts".to_string();
        first.position_encoding = PositionEncoding::UTF16CodeUnitOffsetFromLineStart.into();
        first.symbols.push(local_info.clone());
        first.occurrences = vec![definition.clone(), reference, conflicting_reference];

        let mut second = Document::new();
        second.language = "typescript".to_string();
        second.relative_path = "src/b.ts".to_string();
        second.position_encoding = PositionEncoding::UTF8CodeUnitOffsetFromLineStart.into();
        second.symbols.push(local_info);
        second.occurrences.push(definition);

        let mut index = Index::new();
        index.documents = vec![first.clone(), second, first];
        let projection = project(&index, b"projection", None, &[]).expect("project fixture");

        assert_eq!(projection.documents.len(), 2);
        let local_symbols = projection
            .symbols
            .iter()
            .filter(|symbol| symbol.symbol == "local 0")
            .collect::<Vec<_>>();
        assert_eq!(local_symbols.len(), 2);
        assert_ne!(local_symbols[0].key, local_symbols[1].key);
        assert!(local_symbols.iter().all(|symbol| !symbol.external));

        let reads = projection
            .occurrences
            .iter()
            .filter(|item| item.path == "src/a.ts" && item.kind == "read")
            .collect::<Vec<_>>();
        assert_eq!(reads.len(), 2);
        assert!(reads.iter().all(|item| item.ambiguous));
        assert!(reads.iter().all(|item| item.position_encoding == "utf-16"));
        assert_eq!(reads[0].range.as_ref().expect("typed range").start_line, 1);

        let relationship = projection
            .relationships
            .iter()
            .find(|item| item.kind == "implement")
            .expect("implementation relationship");
        assert_eq!(relationship.path.as_deref(), Some("src/a.ts"));
        assert_eq!(relationship.target_symbol, contract);
    }

    #[test]
    fn rebases_provider_paths_only_inside_the_attested_source_root() {
        let root = fixture("projection-root");
        fs::create_dir_all(&root).expect("create projection root");
        let mut index = Index::new();
        let mut metadata = Metadata::new();
        metadata.project_root = format!("file://{}", root.to_string_lossy());
        index.metadata = MessageField::some(metadata);
        let mut document = Document::new();
        document.language = "typescript".to_string();
        document.relative_path = "generated/../src/main.ts".to_string();
        index.documents.push(document);

        let projection =
            project(&index, b"projection", Some(&root), &[]).expect("rebase inside root");
        assert_eq!(projection.documents[0].path, "src/main.ts");

        index.documents[0].relative_path = "../outside.ts".to_string();
        let error = project(&index, b"projection", Some(&root), &[])
            .err()
            .expect("escape must fail");
        assert!(error.reason.contains("outside the attested source root"));

        index.documents[0].relative_path = "src/main.ts".to_string();
        let other_root = fixture("projection-other-root");
        fs::create_dir_all(&other_root).expect("create other projection root");
        let error = project(&index, b"projection", Some(&other_root), &[])
            .err()
            .expect("mismatched project root must fail");
        assert!(error
            .reason
            .contains("does not match the attested source root"));

        index.documents[0].relative_path = "..\\outside.ts".to_string();
        let error = project(&index, b"projection", Some(&root), &[])
            .err()
            .expect("portable parent escape must fail");
        assert!(error.reason.contains("outside the attested source root"));
        fs::remove_dir_all(other_root).expect("remove other projection root");
        fs::remove_dir_all(root).expect("remove projection root");
    }

    #[test]
    fn keeps_conflicting_overlapping_local_symbols_separate_and_ambiguous() {
        let mut first_info = SymbolInformation::new();
        first_info.symbol = "local 0".to_string();
        first_info.display_name = "first".to_string();
        let mut first_definition = Occurrence::new();
        first_definition.symbol = "local 0".to_string();
        first_definition.symbol_roles = SymbolRole::Definition as i32;
        first_definition.range = vec![0, 0, 1];
        let mut first = Document::new();
        first.relative_path = "same.ts".to_string();
        first.symbols.push(first_info);
        first.occurrences.push(first_definition);

        let mut second_info = SymbolInformation::new();
        second_info.symbol = "local 0".to_string();
        second_info.display_name = "second".to_string();
        let mut second_definition = Occurrence::new();
        second_definition.symbol = "local 0".to_string();
        second_definition.symbol_roles = SymbolRole::Definition as i32;
        second_definition.range = vec![10, 0, 1];
        let mut second = Document::new();
        second.relative_path = "same.ts".to_string();
        second.symbols.push(second_info);
        second.occurrences.push(second_definition);

        let mut index = Index::new();
        index.documents = vec![first.clone(), first, second];
        let projection = project(&index, b"projection", None, &[]).expect("project conflicts");
        let locals = projection
            .symbols
            .iter()
            .filter(|symbol| symbol.symbol == "local 0")
            .collect::<Vec<_>>();
        assert_eq!(locals.len(), 2);
        assert_ne!(locals[0].key, locals[1].key);
        assert!(locals.iter().all(|symbol| symbol.ambiguous));
        let definitions = projection
            .occurrences
            .iter()
            .filter(|item| item.kind == "definition")
            .collect::<Vec<_>>();
        assert_eq!(definitions.len(), 2);
        assert!(definitions.iter().all(|item| item.ambiguous));
    }

    #[test]
    fn applies_only_exact_retained_document_path_aliases() {
        let mut info = SymbolInformation::new();
        info.symbol = "local 0".to_string();
        info.display_name = "main".to_string();
        let mut definition = Occurrence::new();
        definition.symbol = "local 0".to_string();
        definition.symbol_roles = SymbolRole::Definition as i32;
        let mut document = Document::new();
        document.language = "typescript".to_string();
        document.relative_path = "src/main.ts".to_string();
        document.symbols.push(info);
        document.occurrences.push(definition);
        let mut index = Index::new();
        index.documents.push(document);
        let aliases = [NativeScipPathAlias {
            provider_path: "src/main.ts".to_string(),
            path: "Src/Main.ts".to_string(),
        }];

        let projection =
            project(&index, b"projection", None, &aliases).expect("apply retained path identity");
        assert_eq!(projection.documents[0].path, "Src/Main.ts");
        assert_eq!(projection.symbols[0].path.as_deref(), Some("Src/Main.ts"));
        assert_eq!(projection.occurrences[0].path, "Src/Main.ts");
        assert_eq!(projection.path_aliases, aliases);

        let unused = [NativeScipPathAlias {
            provider_path: "other.ts".to_string(),
            path: "Other.ts".to_string(),
        }];
        let error = project(&index, b"projection", None, &unused)
            .err()
            .expect("unused aliases must not rebase unrelated documents");
        assert!(error.reason.contains("do not exactly match"));
    }

    #[cfg(windows)]
    #[test]
    fn parses_unc_file_uri_authorities_as_absolute_paths() {
        let path = super::file_uri_path("file://server/share/project").expect("parse UNC file URI");
        assert!(path.is_absolute());
        assert_eq!(path, std::path::PathBuf::from(r"\\server\share\project"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_untrusted_unc_authorities_before_filesystem_access() {
        let mut metadata = Metadata::new();
        metadata.project_root = "file://untrusted.invalid/share/project".to_string();
        let mut index = Index::new();
        index.metadata = MessageField::some(metadata);
        let expected = std::path::Path::new(r"C:\trusted\input");
        let error = super::project_path_context(&index, Some(expected))
            .err()
            .expect("mismatched UNC authority must fail before canonicalization");
        assert!(error.reason.contains("UNC authority"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_device_namespace_unc_paths_before_filesystem_access() {
        let metadata =
            super::file_uri_path("file://./UNC/192.0.2.1/share/project").expect("parse URI");
        let expected = std::path::Path::new(r"C:\trusted\input");
        let error = super::validate_unc_authority(&metadata, expected)
            .expect_err("device-namespace UNC paths must fail before canonicalization");
        assert!(error.reason.contains("device namespace"));
    }

    #[test]
    fn enforces_the_projected_item_budget_incrementally() {
        let mut budget = ProjectionBudget {
            items: MAX_PROJECTED_FACTS - 1,
        };
        budget.reserve().expect("last permitted item");
        let error = budget
            .reserve()
            .expect_err("one item over the cap must fail");
        assert!(error.reason.contains("unique items"));

        let mut index = Index::new();
        index.documents = vec![Document::new(), Document::new()];
        let error = raw_projection_records(&index, 1)
            .expect_err("raw records must be rejected before projection allocation");
        assert!(error.reason.contains("raw semantic records"));
    }

    #[test]
    fn stages_and_detects_provider_input_mutation() {
        let root = fixture("source");
        let snapshot = fixture("snapshot");
        fs::create_dir_all(root.join("src")).expect("create source fixture");
        fs::write(root.join("src/main.ts"), "export const value = 1;\n")
            .expect("write source fixture");

        let policy = crate::input_policy::InputPolicy::for_root(&root);
        let walked = crate::walk::walk(&root, &policy).files;
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
        validate_snapshot_manifest_sync(&before).expect("validate retained manifest");
        let mut aliased = snapshot_manifest_sync(snapshot.to_str().expect("utf8 snapshot"))
            .expect("manifest with aliases");
        let aliases = [NativeScipPathAlias {
            provider_path: "src/Main.ts".to_string(),
            path: "src/main.ts".to_string(),
        }];
        let alias_map = super::validate_path_aliases(&aliases).expect("valid alias map");
        aliased.path_aliases = Some(aliases.to_vec());
        aliased.path_alias_signature = Some(path_alias_signature(&alias_map));
        validate_snapshot_manifest_sync(&aliased).expect("validate bound path aliases");
        aliased.path_aliases.as_mut().expect("aliases")[0].path = "src/other.ts".to_string();
        let error = validate_snapshot_manifest_sync(&aliased)
            .expect_err("redirected aliases must fail their retained digest");
        assert!(error.reason.contains("path alias signature"));
        let mut tampered = snapshot_manifest_sync(snapshot.to_str().expect("utf8 snapshot"))
            .expect("manifest to tamper");
        tampered.entries[0].path = "..\\outside.ts".to_string();
        let error = validate_snapshot_manifest_sync(&tampered)
            .expect_err("portable path escape must invalidate the manifest");
        assert!(error.reason.contains("unsafe path"));
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
