//! Node bindings for the scan core.
//!
//! One call does the whole pass — walk, hash, parse — because crossing the FFI
//! boundary per file would cost more than the parsing saves. Everything below
//! exposes stable, product-level facts to the Node orchestration boundary.
//!
//! Every entry point that touches the repository runs as an AsyncTask on the
//! libuv pool: a synchronous FFI call blocks the daemon's event loop for the
//! whole scan, during which health pings time out and every consumer reads
//! "not answering" as "not running" — the bridge tells the user to start an
//! engine that is already working, and the desktop shell spawns a doomed
//! duplicate.
//!
//! The structs are `Native*`, not `Js*`: napi-rs has its own `JsSymbol`, and a
//! struct by that name makes the generated index.d.ts declare the field as the
//! JS `symbol` primitive.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use std::path::Path;

mod database;
mod parse;
mod provider;
mod walk;

pub use provider::{
    inspect_scip, project_scip, snapshot_manifest, stage_source_snapshot, verify_snapshot_manifest,
    NativeScipDocument, NativeScipOccurrence, NativeScipPathAlias, NativeScipProjection,
    NativeScipRange, NativeScipRelationship, NativeScipSourceDocument, NativeScipSummary,
    NativeScipSymbol, NativeSnapshotEntry, NativeSnapshotManifest, NativeStagedSnapshot,
};

#[napi(object)]
pub struct NativeSymbol {
    pub kind: String,
    pub name: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub exported: bool,
    pub default_export: bool,
    pub signature: String,
}

#[napi(object)]
pub struct NativeRef {
    /// The name as the defining module exports it.
    pub name: String,
    /// The specifier it came from, still unresolved.
    pub module: String,
    pub line: u32,
    pub column: u32,
}

#[napi(object)]
pub struct NativeFile {
    pub path: String,
    pub lang: String,
    pub loc: u32,
    pub bytes: u32,
    pub content_sha: String,
    pub is_test: bool,
    /// False for files no grammar covers, or that were skipped as noise.
    pub parsed: bool,
    pub symbols: Vec<NativeSymbol>,
    pub imports: Vec<String>,
    /// Uses of imported names, for symbol-level reference resolution.
    pub refs: Vec<NativeRef>,
}

#[napi(object)]
pub struct NativeScan {
    pub files: Vec<NativeFile>,
    pub walk_ms: u32,
    pub parse_ms: u32,
}

#[napi(object)]
pub struct NativeSourceFile {
    pub path: String,
    pub lang: String,
    pub content_sha: String,
    pub is_test: bool,
    pub content: String,
}

#[napi(object)]
pub struct NativePathPolicy {
    pub language: String,
    pub ignored: bool,
    pub noise: bool,
}

fn require_dir(root: &str) -> Result<()> {
    if Path::new(root).is_dir() {
        Ok(())
    } else {
        Err(Error::new(
            Status::InvalidArg,
            format!("Not a directory: {root}"),
        ))
    }
}

fn scan_sync(root: &str) -> NativeScan {
    let path = Path::new(root);

    let started = std::time::Instant::now();
    let scanned = walk::walk(path);
    let walk_ms = started.elapsed().as_millis() as u32;

    let started = std::time::Instant::now();
    let files: Vec<NativeFile> = scanned
        .par_iter()
        .map_init(parse::Engines::new, |engines, file| {
            let parseable =
                !walk::is_noise(&file.path) && parse::grammar_for(&file.path, file.lang).is_some();

            let parsed = if parseable {
                parse::parse(engines, &file.path, file.lang, &file.content)
            } else {
                parse::Parsed::default()
            };

            NativeFile {
                path: file.path.clone(),
                lang: file.lang.to_string(),
                loc: file.loc,
                bytes: file.bytes,
                content_sha: file.content_sha.clone(),
                is_test: file.is_test,
                parsed: parseable,
                symbols: parsed
                    .symbols
                    .into_iter()
                    .map(|symbol| NativeSymbol {
                        kind: symbol.kind,
                        name: symbol.name,
                        start_line: symbol.start_line,
                        start_column: symbol.start_column,
                        end_line: symbol.end_line,
                        end_column: symbol.end_column,
                        exported: symbol.exported,
                        default_export: symbol.default_export,
                        signature: symbol.signature,
                    })
                    .collect(),
                imports: parsed.imports,
                refs: parsed
                    .refs
                    .into_iter()
                    .map(|reference| NativeRef {
                        name: reference.name,
                        module: reference.module,
                        line: reference.line,
                        column: reference.column,
                    })
                    .collect(),
            }
        })
        .collect();
    let parse_ms = started.elapsed().as_millis() as u32;

    NativeScan {
        files,
        walk_ms,
        parse_ms,
    }
}

pub struct ScanTask {
    root: String,
}

#[napi]
impl Task for ScanTask {
    type Output = NativeScan;
    type JsValue = NativeScan;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(scan_sync(&self.root))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Walk and parse a repository. Both phases use every core, off the event loop.
#[napi(ts_return_type = "Promise<NativeScan>")]
pub fn scan_repo(root: String) -> Result<AsyncTask<ScanTask>> {
    require_dir(&root)?;
    Ok(AsyncTask::new(ScanTask { root }))
}

/// Classify a watcher path through the Rust-owned repository policy.
#[napi]
pub fn source_path_policy(path: String) -> NativePathPolicy {
    let normalized = path.replace('\\', "/");
    NativePathPolicy {
        language: walk::classify(&normalized).to_string(),
        ignored: walk::is_watch_ignored_path(&normalized),
        noise: walk::is_noise(&normalized),
    }
}

#[napi(object)]
pub struct NativeMatch {
    pub path: String,
    pub line: u32,
    pub end_line: u32,
    /// The captured node's own text, trimmed for display.
    pub text: String,
    /// Which capture in the query matched, e.g. "@call".
    pub capture: String,
}

fn search_sync(
    root: &str,
    query: &str,
    wanted: &[String],
    cap: usize,
    text_filter: Option<&str>,
) -> Vec<NativeMatch> {
    if cap == 0 {
        return Vec::new();
    }
    let files = walk::walk(Path::new(root));
    let needle = text_filter.map(str::to_lowercase);
    // Each file and the shared aggregate are capped. A broad query must never
    // allocate one result per identifier only to truncate after collection.
    const ORDER: fn(&NativeMatch, &NativeMatch) -> std::cmp::Ordering = |a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line.cmp(&b.line))
            .then(a.end_line.cmp(&b.end_line))
            .then(a.capture.cmp(&b.capture))
            .then(a.text.cmp(&b.text))
    };
    let matches = std::sync::Mutex::new(Vec::<NativeMatch>::with_capacity(cap));
    files
        .par_iter()
        .filter(|file| wanted.iter().any(|lang| lang == file.lang) && !walk::is_noise(&file.path))
        .for_each(|file| {
            let hits = parse::search(
                &file.path,
                file.lang,
                &file.content,
                query,
                needle.as_deref(),
                cap,
            )
            .into_iter()
            .map(|hit| NativeMatch {
                path: file.path.clone(),
                line: hit.line,
                end_line: hit.end_line,
                text: hit.text,
                capture: hit.capture,
            })
            .collect::<Vec<_>>();
            if hits.is_empty() {
                return;
            }
            let mut bounded = matches
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            bounded.extend(hits);
            bounded.sort_by(ORDER);
            bounded.truncate(cap);
        });

    let mut out = matches
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    out.sort_by(ORDER);
    out
}

pub struct SearchTask {
    root: String,
    query: String,
    wanted: Vec<String>,
    cap: usize,
    text_filter: Option<String>,
}

#[napi]
impl Task for SearchTask {
    type Output = Vec<NativeMatch>;
    type JsValue = Vec<NativeMatch>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(search_sync(
            &self.root,
            &self.query,
            &self.wanted,
            self.cap,
            self.text_filter.as_deref(),
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Search by code shape rather than by text.
///
/// A regex finds `catch` and cannot tell an empty handler from a careful one;
/// a tree-sitter query can, because it matches the parsed structure. This is
/// what makes "find every place we swallow an error" a question with an exact
/// answer instead of a grep and a lot of reading.
///
/// The query is tree-sitter's own S-expression syntax, run against whichever
/// grammar each file needs.
#[napi(ts_return_type = "Promise<Array<NativeMatch>>")]
pub fn search_structural(
    root: String,
    query: String,
    languages: Option<Vec<String>>,
    limit: Option<u32>,
    text_filter: Option<String>,
) -> Result<AsyncTask<SearchTask>> {
    require_dir(&root)?;

    let wanted: Vec<String> = languages.unwrap_or_else(|| {
        vec![
            "typescript".to_string(),
            "javascript".to_string(),
            "python".to_string(),
        ]
    });

    // A query that compiles for none of the wanted grammars would otherwise
    // come back as zero matches — and "no matches" for a query that never ran
    // is exactly the silent pass this tool exists to catch. A query valid for
    // some grammars still runs; the files it cannot apply to are skipped.
    if let Err(message) = parse::validate_query(&query, &wanted) {
        return Err(Error::new(Status::InvalidArg, message));
    }

    Ok(AsyncTask::new(SearchTask {
        root,
        query,
        wanted,
        cap: limit.unwrap_or(200) as usize,
        text_filter,
    }))
}

pub struct ReadRepoFilesTask {
    root: String,
}

#[napi]
impl Task for ReadRepoFilesTask {
    type Output = Vec<NativeSourceFile>;
    type JsValue = Vec<NativeSourceFile>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(walk::walk(Path::new(&self.root))
            .into_iter()
            .map(|file| NativeSourceFile {
                path: file.path,
                lang: file.lang.to_string(),
                content_sha: file.content_sha,
                is_test: file.is_test,
                content: file.content,
            })
            .collect())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Read the bounded source inventory for deterministic content analyzers.
#[napi(ts_return_type = "Promise<Array<NativeSourceFile>>")]
pub fn read_repo_files(root: String) -> Result<AsyncTask<ReadRepoFilesTask>> {
    require_dir(&root)?;
    Ok(AsyncTask::new(ReadRepoFilesTask { root }))
}
