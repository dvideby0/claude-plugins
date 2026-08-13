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
mod freshness;
mod git_changes;
mod http_flow;
mod input_policy;
mod parse;
mod signature;
mod provider;
mod task_context;
mod walk;

pub use database::database_schema_version;
pub use provider::{
    inspect_scip, project_scip, snapshot_manifest, stage_source_snapshot, verify_snapshot_manifest,
    NativeScipDocument, NativeScipOccurrence, NativeScipPathAlias, NativeScipProjection,
    NativeScipRange, NativeScipRelationship, NativeScipSourceDocument, NativeScipSummary,
    NativeScipSymbol, NativeSnapshotEntry, NativeSnapshotManifest, NativeStagedSnapshot,
};

#[napi(object)]
pub struct NativeGitChange {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: String,
    pub index_status: String,
    pub worktree_status: String,
    pub worktree_path_present: Option<bool>,
}

#[napi(object)]
pub struct NativeGitChangeSet {
    pub state: String,
    pub source: String,
    pub changes: Vec<NativeGitChange>,
    pub detected_paths: u32,
    pub truncated: bool,
    pub diagnostic: Option<String>,
}

#[napi(object)]
pub struct NativeSymbol {
    pub kind: String,
    pub name: String,
    /// Identity that survives cosmetic edits, unlike the positional id.
    pub symbol_key: String,
    /// The contract callers depend on: the declaration without its body.
    pub interface_sha: String,
    /// The implementation, absent where the declaration has no body.
    pub body_sha: Option<String>,
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
pub struct NativeImport {
    pub specifier: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[napi(object)]
pub struct NativeExecutionNode {
    pub id: String,
    pub ordinal: u32,
    pub kind: String,
    pub label: String,
    pub path: String,
    pub symbol: String,
    pub target_symbol: String,
    pub target_line: u32,
    pub target_column: u32,
    pub external: String,
    pub start_line: u32,
    pub end_line: u32,
    pub certainty: String,
    pub terminal: bool,
    pub detail: String,
}

#[napi(object)]
pub struct NativeExecutionEdge {
    pub ordinal: u32,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub label: String,
    pub path: String,
    pub start_line: u32,
    pub certainty: String,
}

#[napi(object)]
pub struct NativeExecutionEntry {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub method: String,
    pub route: String,
    pub path: String,
    pub symbol: String,
    pub start_line: u32,
    pub end_line: u32,
    pub producer_id: String,
    pub producer_version: String,
    pub producer_kind: String,
    pub certainty: String,
    pub nodes: Vec<NativeExecutionNode>,
    pub edges: Vec<NativeExecutionEdge>,
    pub diagnostics: Vec<String>,
}

#[napi(object)]
pub struct NativeFile {
    pub path: String,
    pub lang: String,
    pub loc: u32,
    pub bytes: u32,
    pub content_sha: String,
    pub is_test: bool,
    /// False for files no grammar covers, or that were skipped as noise. A
    /// property of the file, not of this run: it stays true for a file that was
    /// verified rather than read, which therefore carries no symbols.
    pub parsed: bool,
    /// How this entry was established: `read` or `verified`. The one field that
    /// separates "this file has no symbols" from "this run did not look".
    pub freshness: String,
    /// The filesystem's identity for this file when it can serve as a baseline
    /// for a later scan, and absent when it cannot. Absent never means
    /// unchanged — it means the next scan has to read the file to find out.
    pub stat_key: Option<String>,
    /// The file's meaning with comments and formatting removed. Empty where no
    /// grammar covers the file, which callers read as "not applicable".
    pub syntax_sha: String,
    /// The sorted set of modules and imported names this file depends on.
    pub relation_set_sha: String,
    pub symbols: Vec<NativeSymbol>,
    pub imports: Vec<NativeImport>,
    /// Uses of imported names, for symbol-level reference resolution.
    pub refs: Vec<NativeRef>,
    /// Product-specific entry-to-effect facts extracted by bounded adapters.
    pub execution_entries: Vec<NativeExecutionEntry>,
}

/// One recorded decision to keep a path out of the inventory.
///
/// A pruned directory is one entry, not one per file underneath it — the
/// interior is never enumerated.
#[napi(object)]
pub struct NativeExclusion {
    pub path: String,
    pub directory: bool,
    /// Stable machine key from the input policy's closed reason set.
    pub reason: String,
    /// Which rule matched, for a person reading it.
    pub detail: String,
}

/// Per-reason totals. `paths` counts every decision; `recorded` counts the
/// ones listed individually, so a bounded sample is never read as the whole.
#[napi(object)]
pub struct NativeExclusionCount {
    pub reason: String,
    pub paths: u32,
    pub recorded: u32,
}

#[napi(object)]
pub struct NativeScan {
    pub files: Vec<NativeFile>,
    pub exclusions: Vec<NativeExclusion>,
    pub exclusion_summary: Vec<NativeExclusionCount>,
    /// Set when the walk had to relax a rule rather than report an empty
    /// repository, so the workspace can say what did not happen.
    pub diagnostic: Option<String>,
    /// False only when the gitignore matcher was abandoned entirely. Watch
    /// decisions must match the inventory the scan actually produced.
    pub gitignore_applied: bool,
    pub walk_ms: u32,
    pub parse_ms: u32,
    /// Files read, taken on the filesystem's word, and checked anyway.
    pub files_read: u32,
    pub files_verified: u32,
    pub files_sampled: u32,
    /// Files whose recorded identity matched while their contents had moved,
    /// and still matched when checked again straight afterwards. Above zero
    /// means this filesystem's identity cannot be trusted here, and the walk
    /// has already redone the run reading everything.
    pub freshness_mismatches: u32,
    /// Sampled files written between the stat and the read. Ordinary timing
    /// against a live editor; the run is redone but nothing is distrusted.
    pub freshness_raced: u32,
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
pub struct NativePathDecision {
    pub language: String,
    /// True when this path is part of the trusted inventory.
    pub included: bool,
    /// True when it is also parsed for evidence. Lockfiles are indexed but not.
    pub parseable: bool,
    /// Stable machine key from the input policy's closed reason set.
    pub reason: String,
    /// Which rule decided it, phrased for a person.
    pub detail: String,
    /// Not indexed, but editing it changes the source set — the watcher must
    /// still refresh on it. Today: `.gitignore`.
    pub policy_input: bool,
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

fn scan_sync(root: &str, baseline: Option<freshness::FileBaseline>) -> NativeScan {
    let path = Path::new(root);

    let started = std::time::Instant::now();
    let policy = input_policy::InputPolicy::for_root(path);
    let mode = match &baseline {
        Some(baseline) => walk::WalkMode::Incremental(baseline),
        None => walk::WalkMode::ReadAll,
    };
    let outcome = walk::walk(path, &policy, mode);
    let walk_ms = started.elapsed().as_millis() as u32;

    let started = std::time::Instant::now();
    let files: Vec<NativeFile> = outcome
        .files
        .par_iter()
        .map_init(parse::Engines::new, native_file)
        .collect();
    let parse_ms = started.elapsed().as_millis() as u32;
    assemble_scan(files, outcome, walk_ms, parse_ms)
}

/// Parse one walked file into the shape the Node boundary consumes.
///
/// Shared with the targeted re-parse so a file rebuilt on its own cannot come
/// back in a different shape from the same file rebuilt by a full pass.
fn native_file(engines: &mut parse::Engines, file: &walk::Scanned) -> NativeFile {
            // The input policy already decided whether this file is evidence;
            // re-deriving it here is how the two used to disagree.
            let parseable =
                file.parseable && parse::grammar_for(&file.path, file.lang).is_some();

            // A file the walk verified without reading has no text to parse,
            // and its stored symbols are still correct. This is where the saved
            // work actually is: the read is one cost, the parse is the larger.
            let parsed = match file.content.as_deref() {
                Some(content) if parseable => parse::parse(engines, &file.path, file.lang, content),
                _ => parse::Parsed::default(),
            };

            NativeFile {
                path: file.path.clone(),
                lang: file.lang.to_string(),
                loc: file.loc,
                bytes: file.bytes,
                content_sha: file.content_sha.clone(),
                is_test: file.is_test,
                parsed: parseable,
                freshness: file.freshness.key().to_string(),
                stat_key: file.stat_key.clone(),
                syntax_sha: parsed.syntax_sha.clone(),
                relation_set_sha: parsed.relation_set_sha.clone(),
                symbols: parsed
                    .symbols
                    .into_iter()
                    .map(|symbol| NativeSymbol {
                        kind: symbol.kind,
                        name: symbol.name,
                        symbol_key: symbol.symbol_key,
                        interface_sha: symbol.interface_sha,
                        body_sha: symbol.body_sha,
                        start_line: symbol.start_line,
                        start_column: symbol.start_column,
                        end_line: symbol.end_line,
                        end_column: symbol.end_column,
                        exported: symbol.exported,
                        default_export: symbol.default_export,
                        signature: symbol.signature,
                    })
                    .collect(),
                imports: parsed
                    .imports
                    .into_iter()
                    .map(|import| NativeImport {
                        specifier: import.specifier,
                        start_line: import.start_line,
                        end_line: import.end_line,
                    })
                    .collect(),
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
                execution_entries: parsed
                    .execution_entries
                    .into_iter()
                    .map(|entry| NativeExecutionEntry {
                        id: entry.id,
                        kind: entry.kind,
                        label: entry.label,
                        method: entry.method,
                        route: entry.route,
                        path: entry.path,
                        symbol: entry.symbol,
                        start_line: entry.start_line,
                        end_line: entry.end_line,
                        producer_id: entry.producer_id,
                        producer_version: entry.producer_version,
                        producer_kind: entry.producer_kind,
                        certainty: entry.certainty,
                        nodes: entry
                            .nodes
                            .into_iter()
                            .map(|node| NativeExecutionNode {
                                id: node.id,
                                ordinal: node.ordinal,
                                kind: node.kind,
                                label: node.label,
                                path: node.path,
                                symbol: node.symbol,
                                target_symbol: node.target_symbol,
                                target_line: node.target_line,
                                target_column: node.target_column,
                                external: node.external,
                                start_line: node.start_line,
                                end_line: node.end_line,
                                certainty: node.certainty,
                                terminal: node.terminal,
                                detail: node.detail,
                            })
                            .collect(),
                        edges: entry
                            .edges
                            .into_iter()
                            .map(|edge| NativeExecutionEdge {
                                ordinal: edge.ordinal,
                                from: edge.from,
                                to: edge.to,
                                kind: edge.kind,
                                label: edge.label,
                                path: edge.path,
                                start_line: edge.start_line,
                                certainty: edge.certainty,
                            })
                            .collect(),
                        diagnostics: entry.diagnostics,
                    })
                    .collect(),
            }
}

fn assemble_scan(
    files: Vec<NativeFile>,
    outcome: walk::WalkOutcome,
    walk_ms: u32,
    parse_ms: u32,
) -> NativeScan {
    NativeScan {
        files,
        exclusions: outcome
            .excluded
            .into_iter()
            .map(|entry| NativeExclusion {
                path: entry.path,
                directory: entry.directory,
                reason: entry.reason.to_string(),
                detail: entry.detail,
            })
            .collect(),
        exclusion_summary: outcome
            .summary
            .into_iter()
            .map(|count| NativeExclusionCount {
                reason: count.reason.to_string(),
                paths: count.paths,
                recorded: count.recorded,
            })
            .collect(),
        files_read: outcome.freshness.read,
        files_verified: outcome.freshness.verified,
        files_sampled: outcome.freshness.sampled,
        freshness_mismatches: outcome.freshness.mismatches,
        freshness_raced: outcome.freshness.raced,
        diagnostic: outcome.diagnostic,
        gitignore_applied: outcome.gitignore_applied,
        walk_ms,
        parse_ms,
    }
}

pub struct ScanTask {
    root: String,
    /// Taken by `compute`, which runs once.
    baseline: Option<freshness::FileBaseline>,
}

#[napi]
impl Task for ScanTask {
    type Output = NativeScan;
    type JsValue = NativeScan;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(scan_sync(&self.root, self.baseline.take()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Walk and parse a repository. Both phases use every core, off the event loop.
///
/// `baseline_json` is what the store owner recorded about these files last
/// time, and passing it opts into skipping the read for any file the
/// filesystem says is unchanged. It is produced by `NativeDatabase.fileBaseline`
/// and is opaque to the caller: the shape, the comparison and the decision all
/// live here, so a second implementation of the freshness rule cannot appear on
/// the other side of the boundary. Omit it for a full scan.
#[napi(ts_return_type = "Promise<NativeScan>")]
pub fn scan_repo(root: String, baseline_json: Option<String>) -> Result<AsyncTask<ScanTask>> {
    require_dir(&root)?;
    let baseline = match baseline_json {
        Some(json) => Some(freshness::parse_baseline(&json)?),
        None => None,
    };
    Ok(AsyncTask::new(ScanTask { root, baseline }))
}

pub struct GitChangesTask {
    root: String,
    isolated_config: bool,
}

#[napi]
impl Task for GitChangesTask {
    type Output = NativeGitChangeSet;
    type JsValue = NativeGitChangeSet;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(git_changes::detect(&self.root, self.isolated_config))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Read staged, unstaged, renamed, and untracked paths through Git porcelain.
/// Failure is returned as explicit degraded state so retrieval still works.
#[napi(ts_return_type = "Promise<NativeGitChangeSet>")]
pub fn git_changes(
    root: String,
    isolated_config: Option<bool>,
) -> Result<AsyncTask<GitChangesTask>> {
    require_dir(&root)?;
    Ok(AsyncTask::new(GitChangesTask {
        root,
        isolated_config: isolated_config.unwrap_or(false),
    }))
}

/// Ask the repository input policy about one path, and why.
///
/// This is the same function the scan walk uses, so a watcher decision and an
/// inventory decision cannot disagree. `root` reads the repository's committed
/// `.gitignore`; pass `None` to classify a bare path on shape alone.
/// `directory` distinguishes `dist/` the build directory from `dist.ts` the
/// source file, which is the one thing a path string cannot say by itself.
/// `ignore_gitignore` mirrors a scan that had to relax that rule, so watcher
/// decisions match the inventory the scan actually produced.
#[napi]
pub fn source_path_decision(
    path: String,
    root: Option<String>,
    directory: Option<bool>,
    ignore_gitignore: Option<bool>,
) -> NativePathDecision {
    let normalized = path.replace('\\', "/");
    let policy = match root.as_deref() {
        // A scan that had to relax the gitignore rule indexed files this
        // matcher would reject. Asking with the strict policy would classify
        // every later edit to them as generated output, so the watcher would
        // stop refreshing and the index would go quietly stale.
        Some(_) if ignore_gitignore.unwrap_or(false) => input_policy::InputPolicy::path_only(),
        // Cached: the watcher asks this per filesystem event, and rebuilding
        // meant a file read and a glob compile every time.
        Some(root) => input_policy::InputPolicy::cached_for_root(Path::new(root)),
        None => input_policy::InputPolicy::path_only(),
    };
    let kind = match directory {
        Some(true) => input_policy::EntryKind::Directory,
        Some(false) => input_policy::EntryKind::File,
        // A recursive watcher reports a directory rename as a bare path with
        // no extension and nothing left to stat.
        None => input_policy::EntryKind::Unknown,
    };
    let decision = policy.decide(&normalized, kind);
    NativePathDecision {
        language: decision.language.to_string(),
        included: decision.included(),
        parseable: decision.parseable(),
        reason: decision.reason.key().to_string(),
        detail: decision.detail,
        policy_input: decision.policy_input,
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
    let root_path = Path::new(root);
    let policy = input_policy::InputPolicy::for_root(root_path);
    // Structural search reads the text of every file, so it asks for it.
    let files = walk::walk(root_path, &policy, walk::WalkMode::ReadAll).files;
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
        .filter(|file| wanted.iter().any(|lang| lang == file.lang) && file.parseable)
        .for_each(|file| {
            // Always present for the mode above. Skipping rather than
            // substituting an empty string keeps a later mode change from
            // quietly reporting no matches in every file.
            let Some(content) = file.content.as_deref() else {
                return;
            };
            let hits = parse::search(
                &file.path,
                file.lang,
                content,
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
        let root = Path::new(&self.root);
        let policy = input_policy::InputPolicy::for_root(root);
        Ok(walk::walk(root, &policy, walk::WalkMode::ReadAll)
            .files
            .into_iter()
            // The content analyzers exist to look at the bytes, so a file
            // without them is not something to pass on as empty.
            .filter_map(|file| {
                Some(NativeSourceFile {
                    path: file.path,
                    lang: file.lang.to_string(),
                    content_sha: file.content_sha,
                    is_test: file.is_test,
                    content: file.content?,
                })
            })
            .collect())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct ParsePathsTask {
    root: String,
    paths: Vec<String>,
    ignore_gitignore: bool,
}

#[napi]
impl Task for ParsePathsTask {
    type Output = Vec<NativeFile>;
    type JsValue = Vec<NativeFile>;

    fn compute(&mut self) -> Result<Self::Output> {
        let root = Path::new(&self.root);
        // The same policy the walk actually applied, not the strict one. A
        // repository whose catch-all `.gitignore` made the walk relax is
        // indexed under the relaxed rule, and asking the strict policy here
        // would reject every path — returning nothing, rebuilding nothing, and
        // losing exactly the references this task exists to preserve.
        let policy = if self.ignore_gitignore {
            input_policy::InputPolicy::path_only()
        } else {
            input_policy::InputPolicy::for_root(root)
        };
        Ok(walk::read_paths(root, &policy, &self.paths)
            .par_iter()
            .map_init(parse::Engines::new, native_file)
            .collect())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Re-read and parse named files, bypassing the walk and any baseline.
///
/// The companion to an incremental scan. A scan only learns which unchanged
/// files it must rebuild anyway — the callers of something that was deleted —
/// after the walk has already skipped them, and their stored references have
/// been dropped by then. Asking for those paths by name rebuilds them without
/// giving up the fast path for everything else.
/// `ignore_gitignore` mirrors a walk that had to relax that rule, for the same
/// reason `source_path_decision` takes it: a decision made under a different
/// policy from the one that built the inventory is not the same decision.
#[napi(ts_return_type = "Promise<Array<NativeFile>>")]
pub fn parse_repo_paths(
    root: String,
    paths: Vec<String>,
    ignore_gitignore: Option<bool>,
) -> Result<AsyncTask<ParsePathsTask>> {
    require_dir(&root)?;
    Ok(AsyncTask::new(ParsePathsTask {
        root,
        paths,
        ignore_gitignore: ignore_gitignore.unwrap_or(false),
    }))
}

/// Read the bounded source inventory for deterministic content analyzers.
#[napi(ts_return_type = "Promise<Array<NativeSourceFile>>")]
pub fn read_repo_files(root: String) -> Result<AsyncTask<ReadRepoFilesTask>> {
    require_dir(&root)?;
    Ok(AsyncTask::new(ReadRepoFilesTask { root }))
}
