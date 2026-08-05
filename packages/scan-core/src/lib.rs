//! Node bindings for the scan core.
//!
//! One call does the whole pass — walk, hash, parse — because crossing the FFI
//! boundary per file would cost more than the parsing saves. Everything below
//! is shaped to match what the TypeScript pipeline already produces.
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

mod parse;
mod walk;

#[napi(object)]
pub struct NativeSymbol {
    pub kind: String,
    pub name: String,
    pub start_line: u32,
    pub end_line: u32,
    pub exported: bool,
    pub signature: String,
}

#[napi(object)]
pub struct NativeRef {
    /// The name as the defining module exports it.
    pub name: String,
    /// The specifier it came from, still unresolved.
    pub module: String,
    pub line: u32,
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
            let parseable = !walk::is_noise(&file.path)
                && parse::grammar_for(&file.path, file.lang).is_some();

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
                        end_line: symbol.end_line,
                        exported: symbol.exported,
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
    let files = walk::walk(Path::new(root));
    let needle = text_filter.map(str::to_lowercase);
    let matches: Vec<NativeMatch> = files
        .par_iter()
        .filter(|file| wanted.iter().any(|lang| lang == file.lang) && !walk::is_noise(&file.path))
        .flat_map_iter(|file| {
            parse::search(
                &file.path,
                file.lang,
                &file.content,
                query,
                needle.as_deref(),
            )
            .into_iter()
            .map(|hit| NativeMatch {
                path: file.path.clone(),
                line: hit.line,
                end_line: hit.end_line,
                text: hit.text,
                capture: hit.capture,
            })
            .collect::<Vec<_>>()
        })
        .collect();

    let mut out = matches;
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    out.truncate(cap);
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

pub struct WalkTask {
    root: String,
}

#[napi]
impl Task for WalkTask {
    type Output = Vec<NativeFile>;
    type JsValue = Vec<NativeFile>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(walk::walk(Path::new(&self.root))
            .into_iter()
            .map(|file| NativeFile {
                path: file.path,
                lang: file.lang.to_string(),
                loc: file.loc,
                bytes: file.bytes,
                content_sha: file.content_sha,
                is_test: file.is_test,
                parsed: false,
                symbols: Vec::new(),
                imports: Vec::new(),
                refs: Vec::new(),
            })
            .collect())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Walk only — used to compare phases against the TypeScript walker.
#[napi(ts_return_type = "Promise<Array<NativeFile>>")]
pub fn walk_repo(root: String) -> Result<AsyncTask<WalkTask>> {
    require_dir(&root)?;
    Ok(AsyncTask::new(WalkTask { root }))
}
