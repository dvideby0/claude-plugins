//! Deterministic task-context retrieval over the app-owned knowledge store.
//!
//! This is intentionally a ranking and evidence-selection layer, not another
//! language resolver. Compiler/SCIP providers populate the facts; this module
//! combines those facts with authored knowledge and bounded graph neighbours
//! so the MCP boundary can read only the source ranges that matter.

use crate::database::{database_error, invalid_argument, search_knowledge_json};
use napi::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const INTENTS: &[&str] = &["implement", "debug", "refactor", "review", "understand"];
const MAX_TASK_BYTES: usize = 512;
const MAX_TARGET_BYTES: usize = 512;
const MAX_TARGETS: usize = 8;
const MULTI_SIGNAL_BOOST: i64 = 30;
const MAX_MULTI_SIGNAL_BOOST: i64 = 90;
const REPEATED_PATH_PENALTY: i64 = 120;
const MAX_CHANGE_INPUTS: usize = 256;
const MAX_CHANGE_SEEDS: usize = 24;
const EXPLICIT_FILE_SCORE: i64 = 2_000;
const EXPLICIT_SYMBOL_SCORE: i64 = 2_040;
const CHANGE_FILE_SCORE: i64 = 1_180;
const CHANGE_SYMBOL_SCORE: i64 = 1_140;
const UNRELATED_CHANGE_FILE_SCORE: i64 = 860;
const UNRELATED_CHANGE_SYMBOL_SCORE: i64 = 820;

#[derive(Clone, Debug)]
struct FileMeta {
    path: String,
    lang: String,
    loc: u32,
    is_test: bool,
    content_sha: String,
    ref_coverage: String,
}

#[derive(Clone, Debug)]
struct Candidate {
    id: String,
    kind: String,
    title: String,
    detail: String,
    path: Option<String>,
    symbol: Option<String>,
    start_line: Option<u32>,
    end_line: Option<u32>,
    evidence_sha: Option<String>,
    indexed_sha: Option<String>,
    /// Comment-invariant signatures, where the artifact and file both carry
    /// one. Authored knowledge describes what code means, so reformatting the
    /// file it points at must not report it stale here while every other
    /// reader calls it current.
    evidence_meaning: Option<String>,
    indexed_meaning: Option<String>,
    provenance: String,
    certainty: String,
    freshness_override: Option<String>,
    score: i64,
    reasons: BTreeSet<String>,
    is_test: bool,
    source_backed: bool,
}

#[derive(Default)]
struct RetrievalOmissions {
    candidates: usize,
}

#[derive(Clone, Debug)]
struct ChangeSeed {
    path: String,
    previous_path: Option<String>,
    status: String,
    index_status: String,
    worktree_status: String,
    worktree_path_present: Option<bool>,
}

#[derive(Clone, Debug)]
struct ChangeEvidence {
    change: ChangeSeed,
    index_state: &'static str,
}

#[derive(Clone, Debug)]
struct ChangeInput {
    state: String,
    source: Option<String>,
    changes: Vec<ChangeSeed>,
    detected_paths: usize,
    truncated: bool,
    diagnostic: Option<String>,
}

impl Default for ChangeInput {
    fn default() -> Self {
        Self {
            state: "not-requested".to_string(),
            source: None,
            changes: Vec::new(),
            detected_paths: 0,
            truncated: false,
            diagnostic: None,
        }
    }
}

#[derive(Debug)]
struct ReferenceEvidence {
    src_path: String,
    src_line: u32,
    src_column: u32,
    src_symbol: Option<String>,
    name: String,
    specifier: String,
    dst_path: Option<String>,
    dst_symbol_id: Option<String>,
    dst_symbol: Option<String>,
    content_sha: String,
    ref_generation: Option<String>,
    ref_source_signature: Option<String>,
    is_test: bool,
    total: usize,
}

impl Candidate {
    fn freshness(&self) -> &'static str {
        if !self.source_backed {
            return "not-applicable";
        }
        if let Some(freshness) = self.freshness_override.as_deref() {
            return match freshness {
                "current" => "current",
                "stale" => "stale",
                _ => "unverified",
            };
        }
        // Never compare one side's syntax signature against the other's
        // content hash: a store upgraded but not yet rescanned has anchors
        // with no syntax signature and files that already have one.
        if let (Some(evidence), Some(indexed)) = (&self.evidence_meaning, &self.indexed_meaning) {
            return if evidence == indexed { "current" } else { "stale" };
        }
        match (&self.evidence_sha, &self.indexed_sha) {
            (Some(evidence), Some(indexed)) if evidence == indexed => "current",
            (Some(_), Some(_)) => "stale",
            _ => "unverified",
        }
    }

    fn into_value(self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "detail": self.detail,
            "path": self.path,
            "symbol": self.symbol,
            "startLine": self.start_line,
            "endLine": self.end_line,
            "evidenceSha": self.evidence_sha,
            "indexedSha": self.indexed_sha,
            // True when this verdict was reached by comparing meaning rather
            // than bytes, so the Node boundary does not re-apply a content
            // comparison that would call a comment-only edit stale.
            "meaningVerified": self.evidence_meaning.is_some() && self.indexed_meaning.is_some(),
            "sourceBacked": self.source_backed,
            "isTest": self.is_test,
            "score": self.score,
            "reasons": self.reasons,
            "provenance": {
                "source": self.provenance,
                "certainty": self.certainty,
                "freshness": self.freshness(),
            },
        })
    }
}

#[derive(Default)]
struct CandidateSet {
    values: HashMap<String, Candidate>,
}

impl CandidateSet {
    fn insert(&mut self, mut candidate: Candidate) {
        if let Some(existing) = self.values.get_mut(&candidate.id) {
            let mut reasons = existing.reasons.clone();
            reasons.append(&mut candidate.reasons);
            if candidate.score > existing.score {
                candidate.reasons = reasons;
                *existing = candidate;
            } else {
                existing.reasons = reasons;
            }
            return;
        }
        self.values.insert(candidate.id.clone(), candidate);
    }

    fn mark_path_stale(&mut self, path: &str, why: &str) {
        for candidate in self
            .values
            .values_mut()
            .filter(|candidate| candidate.path.as_deref() == Some(path))
        {
            candidate.freshness_override = Some("stale".to_string());
            candidate.reasons.insert(why.to_string());
        }
    }

    fn ranked(mut self, intent: &str, limit: usize) -> (Vec<Candidate>, usize) {
        for candidate in self.values.values_mut() {
            candidate.score += intent_boost(intent, candidate) + multi_signal_boost(candidate);
        }
        let total = self.values.len();
        let mut remaining: Vec<Candidate> = self.values.into_values().collect();
        let mut path_counts = HashMap::<String, usize>::new();
        let mut ranked = Vec::with_capacity(limit.min(total));
        while !remaining.is_empty() && ranked.len() < limit {
            remaining.sort_by(|left, right| {
                marginal_score(right, &path_counts)
                    .cmp(&marginal_score(left, &path_counts))
                    .then_with(|| {
                        path_repeat_count(left, &path_counts)
                            .cmp(&path_repeat_count(right, &path_counts))
                    })
                    .then_with(|| right.score.cmp(&left.score))
                    .then_with(|| right.is_test.cmp(&left.is_test))
                    .then_with(|| left.kind.cmp(&right.kind))
                    .then_with(|| left.title.cmp(&right.title))
                    .then_with(|| left.id.cmp(&right.id))
            });
            let mut candidate = remaining.remove(0);
            if let Some(path) = candidate.path.as_ref() {
                let repeats = path_counts.get(path).copied().unwrap_or(0);
                if repeats > 0 {
                    candidate.score = candidate
                        .score
                        .saturating_sub(repeat_path_penalty(repeats))
                        .max(0);
                    candidate
                        .reasons
                        .insert("repeated-path diversity penalty".to_string());
                }
                *path_counts.entry(path.clone()).or_default() += 1;
            }
            ranked.push(candidate);
        }
        (ranked, total.saturating_sub(limit))
    }
}

fn multi_signal_boost(candidate: &Candidate) -> i64 {
    let additional_signals = candidate.reasons.len().saturating_sub(1).min(3);
    i64::try_from(additional_signals)
        .unwrap_or(3)
        .saturating_mul(MULTI_SIGNAL_BOOST)
        .min(MAX_MULTI_SIGNAL_BOOST)
}

fn repeat_path_penalty(repeats: usize) -> i64 {
    i64::try_from(repeats)
        .unwrap_or(i64::MAX)
        .saturating_mul(REPEATED_PATH_PENALTY)
}

fn marginal_score(candidate: &Candidate, path_counts: &HashMap<String, usize>) -> i64 {
    candidate
        .score
        .saturating_sub(repeat_path_penalty(path_repeat_count(
            candidate,
            path_counts,
        )))
        .max(0)
}

fn path_repeat_count(candidate: &Candidate, path_counts: &HashMap<String, usize>) -> usize {
    candidate
        .path
        .as_ref()
        .and_then(|path| path_counts.get(path))
        .copied()
        .unwrap_or(0)
}

fn intent_boost(intent: &str, candidate: &Candidate) -> i64 {
    let kind = candidate.kind.as_str();
    match intent {
        "debug" => match kind {
            "finding" => 120,
            "execution" | "flow" => 70,
            _ if candidate.is_test => 80,
            _ => 0,
        },
        "implement" | "refactor" => match kind {
            "symbol" | "reference" => 70,
            _ if candidate.is_test => 60,
            _ => 0,
        },
        "review" => match kind {
            "finding" | "memory" => 90,
            _ if candidate.is_test => 80,
            _ => 0,
        },
        "understand" => match kind {
            "execution" | "flow" | "component" => 90,
            "memory" => 60,
            _ => 0,
        },
        _ => 0,
    }
}

fn bounded_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", value[..end].trim_end())
}

fn positive_line(value: Option<i64>) -> Option<u32> {
    value
        .and_then(|line| u32::try_from(line).ok())
        .filter(|line| *line > 0)
}

fn normalized_change_path(value: &str) -> Option<String> {
    // The same rule the Git adapter applies, from the same place. These two
    // had drifted into separate copies of one confinement decision, and the
    // copies disagreed on Windows.
    crate::git_changes::confined_relative_path(value)
}

fn parse_change_input(changes_json: Option<&str>) -> Result<ChangeInput> {
    let Some(changes_json) = changes_json else {
        return Ok(ChangeInput::default());
    };
    let value: Value = serde_json::from_str(changes_json)
        .map_err(|error| invalid_argument(format!("Invalid task-context changes: {error}")))?;
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unavailable");
    if ![
        "available",
        "not-repository",
        "unavailable",
        "not-requested",
    ]
    .contains(&state)
    {
        return Err(invalid_argument(format!(
            "Unknown task-context change state {state}"
        )));
    }
    let raw_changes = value
        .get("changes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let raw_change_count = raw_changes.len();
    let mut rejected_paths = 0_usize;
    let mut changes = BTreeMap::<String, ChangeSeed>::new();
    for raw in raw_changes.into_iter().take(MAX_CHANGE_INPUTS) {
        let Some(path) = raw
            .get("path")
            .and_then(Value::as_str)
            .and_then(normalized_change_path)
        else {
            rejected_paths += 1;
            continue;
        };
        let previous_path = match raw.get("previousPath").and_then(Value::as_str) {
            Some(previous) => match normalized_change_path(previous) {
                Some(previous) => Some(previous),
                None => {
                    rejected_paths += 1;
                    None
                }
            },
            None => None,
        };
        let status = bounded_text(
            raw.get("status")
                .and_then(Value::as_str)
                .unwrap_or("changed"),
            80,
        );
        let index_status = bounded_text(
            raw.get("indexStatus").and_then(Value::as_str).unwrap_or(""),
            8,
        );
        let worktree_status = bounded_text(
            raw.get("worktreeStatus")
                .and_then(Value::as_str)
                .unwrap_or(""),
            8,
        );
        let worktree_path_present = raw.get("worktreePathPresent").and_then(Value::as_bool);
        changes.insert(
            path.clone(),
            ChangeSeed {
                path,
                previous_path,
                status,
                index_status,
                worktree_status,
                worktree_path_present,
            },
        );
    }
    let detected_paths = value
        .get("detectedPaths")
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or(raw_change_count)
        .max(raw_change_count)
        .max(changes.len());
    let input_truncated = value
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || raw_change_count > MAX_CHANGE_INPUTS
        || rejected_paths > 0;
    let mut diagnostic = value
        .get("diagnostic")
        .and_then(Value::as_str)
        .map(|diagnostic| bounded_text(diagnostic, 400));
    if rejected_paths > 0 && diagnostic.is_none() {
        diagnostic = Some(format!(
            "{rejected_paths} changed path value(s) were outside the bounded contained-path envelope."
        ));
    }
    Ok(ChangeInput {
        state: state.to_string(),
        source: value
            .get("source")
            .and_then(Value::as_str)
            .map(|source| bounded_text(source, 80)),
        changes: changes.into_values().collect(),
        detected_paths,
        truncated: input_truncated,
        diagnostic,
    })
}

fn change_context_value(input: &ChangeInput, considered: &[ChangeEvidence]) -> Value {
    let mut context = serde_json::Map::new();
    context.insert("state".to_string(), json!(input.state));
    context.insert("source".to_string(), json!(input.source));
    context.insert("detectedPaths".to_string(), json!(input.detected_paths));
    if !considered.is_empty() {
        context.insert(
            "changes".to_string(),
            Value::Array(
                considered
                    .iter()
                    .map(|evidence| {
                        let change = &evidence.change;
                        let mut value = serde_json::Map::new();
                        value.insert("path".to_string(), json!(change.path));
                        value.insert("status".to_string(), json!(change.status));
                        value.insert("indexState".to_string(), json!(evidence.index_state));
                        if let Some(previous_path) = change.previous_path.as_ref() {
                            value.insert("previousPath".to_string(), json!(previous_path));
                        }
                        Value::Object(value)
                    })
                    .collect(),
            ),
        );
    }
    let omitted_paths = input.detected_paths.saturating_sub(considered.len());
    if omitted_paths > 0 {
        context.insert("omittedPaths".to_string(), json!(omitted_paths));
    }
    if input.truncated {
        context.insert("truncated".to_string(), Value::Bool(true));
    }
    if let Some(diagnostic) = input.diagnostic.as_ref() {
        context.insert("diagnostic".to_string(), json!(diagnostic));
    }
    Value::Object(context)
}

fn file_meta(connection: &Connection, path: &str) -> Result<Option<FileMeta>> {
    connection
        .query_row(
            "SELECT path, lang, loc, is_test, content_sha, ref_coverage
             FROM files WHERE path = ?1 AND present = 1",
            [path],
            |row| {
                Ok(FileMeta {
                    path: row.get(0)?,
                    lang: row.get(1)?,
                    loc: u32::try_from(row.get::<_, i64>(2)?).unwrap_or(u32::MAX),
                    is_test: row.get::<_, i64>(3)? != 0,
                    content_sha: row.get(4)?,
                    ref_coverage: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| database_error("Cannot read task-context file evidence", error))
}

fn historical_file_meta(connection: &Connection, path: &str) -> Result<Option<FileMeta>> {
    connection
        .query_row(
            "SELECT path, lang, loc, is_test, content_sha, ref_coverage
             FROM files WHERE path = ?1",
            [path],
            |row| {
                Ok(FileMeta {
                    path: row.get(0)?,
                    lang: row.get(1)?,
                    loc: u32::try_from(row.get::<_, i64>(2)?).unwrap_or(u32::MAX),
                    is_test: row.get::<_, i64>(3)? != 0,
                    content_sha: row.get(4)?,
                    ref_coverage: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| database_error("Cannot read historical task-context file evidence", error))
}

fn reason(value: &str) -> BTreeSet<String> {
    [value.to_string()].into_iter().collect()
}

fn file_candidate(file: &FileMeta, score: i64, why: &str) -> Candidate {
    Candidate {
        id: format!("file:{}", file.path),
        kind: "file".to_string(),
        title: file.path.clone(),
        detail: format!(
            "{} source · {} lines · {} reference coverage",
            file.lang, file.loc, file.ref_coverage
        ),
        path: Some(file.path.clone()),
        symbol: None,
        start_line: Some(1),
        end_line: Some(file.loc.clamp(1, 40)),
        evidence_sha: Some(file.content_sha.clone()),
        indexed_sha: Some(file.content_sha.clone()),
        evidence_meaning: None,
        indexed_meaning: None,
        provenance: "deterministic-index".to_string(),
        certainty: "deterministic".to_string(),
        freshness_override: None,
        score,
        reasons: reason(why),
        is_test: file.is_test,
        source_backed: true,
    }
}

fn historical_change_candidate(
    file: &FileMeta,
    change: &ChangeSeed,
    provenance: &str,
    score: i64,
) -> Candidate {
    Candidate {
        id: format!("change:{}", change.path),
        kind: "change".to_string(),
        title: format!("{} [{}]", change.path, change.status),
        detail: format!(
            "{} working-tree path · previously indexed {} source · {} lines",
            change.status, file.lang, file.loc
        ),
        path: Some(change.path.clone()),
        symbol: None,
        start_line: Some(1),
        end_line: Some(file.loc.clamp(1, 40)),
        evidence_sha: Some(file.content_sha.clone()),
        indexed_sha: Some(file.content_sha.clone()),
        evidence_meaning: None,
        indexed_meaning: None,
        provenance: provenance.to_string(),
        certainty: "deterministic".to_string(),
        freshness_override: Some("stale".to_string()),
        score,
        reasons: reason("historical index evidence for changed path"),
        is_test: file.is_test,
        // Materialization intentionally attempts the old path. A deletion is
        // then returned as navigable historical evidence with an explicit
        // unavailable-source error instead of disappearing from the brief.
        source_backed: true,
    }
}

fn add_file(
    connection: &Connection,
    candidates: &mut CandidateSet,
    path: &str,
    score: i64,
    why: &str,
) -> Result<()> {
    if let Some(file) = file_meta(connection, path)? {
        candidates.insert(file_candidate(&file, score, why));
    }
    Ok(())
}

fn symbol_candidate(
    connection: &Connection,
    id: &str,
    score: i64,
    why: &str,
) -> Result<Option<Candidate>> {
    connection
        .query_row(
            "SELECT s.id, s.path, s.kind, s.name, s.start_line, s.end_line,
                    s.exported, COALESCE(s.signature, ''), f.is_test, f.content_sha
             FROM symbols s JOIN files f ON f.path = s.path
             WHERE s.id = ?1 AND f.present = 1",
            [id],
            |row| {
                let path: String = row.get(1)?;
                let kind: String = row.get(2)?;
                let name: String = row.get(3)?;
                let exported = row.get::<_, i64>(6)? != 0;
                let signature: String = row.get(7)?;
                let indexed_sha: String = row.get(9)?;
                Ok(Candidate {
                    id: format!("symbol:{}", row.get::<_, String>(0)?),
                    kind: "symbol".to_string(),
                    title: format!("{}#{}", path, name),
                    detail: bounded_text(
                        &format!(
                            "{}{}{}",
                            kind,
                            if exported { " · exported" } else { "" },
                            if signature.is_empty() {
                                String::new()
                            } else {
                                format!(" · {signature}")
                            }
                        ),
                        800,
                    ),
                    path: Some(path),
                    symbol: Some(name),
                    start_line: positive_line(Some(row.get(4)?)),
                    end_line: positive_line(Some(row.get(5)?)),
                    evidence_sha: Some(indexed_sha.clone()),
                    indexed_sha: Some(indexed_sha),
                    evidence_meaning: None,
                    indexed_meaning: None,
                    provenance: "deterministic-index".to_string(),
                    certainty: "deterministic".to_string(),
                    freshness_override: None,
                    score,
                    reasons: reason(why),
                    is_test: row.get::<_, i64>(8)? != 0,
                    source_backed: true,
                })
            },
        )
        .optional()
        .map_err(|error| database_error("Cannot read task-context symbol evidence", error))
}

fn add_symbol(
    connection: &Connection,
    candidates: &mut CandidateSet,
    id: &str,
    score: i64,
    why: &str,
) -> Result<()> {
    if let Some(candidate) = symbol_candidate(connection, id, score, why)? {
        candidates.insert(candidate);
    }
    Ok(())
}

fn dependency_candidate(
    source: &FileMeta,
    specifier: &str,
    destination: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
    score: i64,
) -> Candidate {
    let end_line = start_line.map(|start| end_line.unwrap_or(start).max(start));
    Candidate {
        id: format!("edge:{}:{specifier}", source.path),
        kind: "dependency".to_string(),
        title: format!("{} imports {destination}", source.path),
        detail: format!("Resolved import {specifier} → {destination}"),
        // An edge is produced by the importing source. Anchoring it to the
        // destination makes an obsolete import look current when the importer
        // changes in the working tree but has not been re-indexed yet.
        path: Some(source.path.clone()),
        symbol: None,
        start_line,
        end_line,
        evidence_sha: Some(source.content_sha.clone()),
        indexed_sha: Some(source.content_sha.clone()),
        evidence_meaning: None,
        indexed_meaning: None,
        provenance: "deterministic-index".to_string(),
        certainty: if start_line.is_some() {
            "resolved".to_string()
        } else {
            "resolved-without-source-range".to_string()
        },
        freshness_override: None,
        score,
        reasons: reason("direct dependency"),
        is_test: source.is_test,
        source_backed: start_line.is_some(),
    }
}

fn add_dependency_candidates(
    connection: &Connection,
    candidates: &mut CandidateSet,
    omissions: &mut RetrievalOmissions,
    path: &str,
) -> Result<()> {
    let Some(source) = file_meta(connection, path)? else {
        return Ok(());
    };
    let mut statement = connection
        .prepare(
            "SELECT specifier, dst_path, start_line, end_line, COUNT(*) OVER()
             FROM edges
             WHERE src_path = ?1 AND dst_path IS NOT NULL
             ORDER BY dst_path, specifier LIMIT 24",
        )
        .map_err(|error| database_error("Cannot find direct task dependencies", error))?;
    let rows = statement
        .query_map([path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                positive_line(row.get(2)?),
                positive_line(row.get(3)?),
                usize::try_from(row.get::<_, i64>(4)?).unwrap_or(usize::MAX),
            ))
        })
        .map_err(|error| database_error("Cannot find direct task dependencies", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read direct task dependencies", error))?;
    let total = rows.first().map_or(0, |row| row.4);
    omissions.candidates += total.saturating_sub(rows.len());
    for (specifier, destination, start_line, end_line, _) in rows {
        candidates.insert(dependency_candidate(
            &source,
            &specifier,
            &destination,
            start_line,
            end_line,
            660,
        ));
        // The producer-backed edge is the relationship evidence. The lower
        // ranked destination remains useful source context without standing in
        // for that evidence or its freshness.
        add_file(
            connection,
            candidates,
            &destination,
            620,
            "dependency destination",
        )?;
    }
    Ok(())
}

fn reference_evidence_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReferenceEvidence> {
    Ok(ReferenceEvidence {
        src_path: row.get(0)?,
        src_line: u32::try_from(row.get::<_, i64>(1)?).unwrap_or(u32::MAX),
        src_column: u32::try_from(row.get::<_, i64>(2)?).unwrap_or(u32::MAX),
        src_symbol: row.get(3)?,
        name: row.get(4)?,
        specifier: row.get(5)?,
        dst_path: row.get(6)?,
        dst_symbol_id: row.get(7)?,
        dst_symbol: row.get(8)?,
        content_sha: row.get(9)?,
        ref_generation: row.get(10)?,
        ref_source_signature: row.get(11)?,
        is_test: row.get::<_, i64>(12)? != 0,
        total: usize::try_from(row.get::<_, i64>(13)?).unwrap_or(usize::MAX),
    })
}

fn collect_reference_evidence(
    connection: &Connection,
    sql: &str,
    path: &str,
    limit: usize,
    destination_symbol_id: Option<&str>,
    context: &str,
) -> Result<(Vec<ReferenceEvidence>, usize)> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| database_error(context, error))?;
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let mapped = if let Some(symbol_id) = destination_symbol_id {
        statement.query_map(params![path, limit, symbol_id], reference_evidence_from_row)
    } else {
        statement.query_map(params![path, limit], reference_evidence_from_row)
    };
    let rows = mapped
        .map_err(|error| database_error(context, error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error(context, error))?;
    let total = rows.first().map_or(0, |row| row.total);
    let omitted = total.saturating_sub(rows.len());
    Ok((rows, omitted))
}

fn typed_workspace_generation(connection: &Connection) -> Result<String> {
    let mut statement = connection
        .prepare("SELECT path, content_sha FROM files WHERE present = 1 ORDER BY path")
        .map_err(|error| database_error("Cannot prepare task-context source generation", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| database_error("Cannot read task-context source generation", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot collect task-context source generation", error))?;
    let joined = rows
        .into_iter()
        .map(|(path, content_sha)| format!("{path}:{content_sha}"))
        .collect::<Vec<_>>()
        .join("|");
    let digest = format!("{:x}", Sha256::digest(joined.as_bytes()));
    Ok(digest[..20].to_string())
}

fn reference_generation_freshness(
    row: &ReferenceEvidence,
    current_generation: &str,
) -> Option<String> {
    if !is_typed_reference(&row.specifier) {
        return None;
    }
    Some(
        match (&row.ref_generation, &row.ref_source_signature) {
            (Some(generation), Some(_)) if generation != current_generation => "stale",
            // The compiler adapter does not attest the complete package and
            // standard-library input closure, so even a matching generation is
            // useful but not strong enough to call current.
            _ => "unverified",
        }
        .to_string(),
    )
}

fn is_typed_reference(specifier: &str) -> bool {
    specifier == "typed" || specifier.starts_with("typed:")
}

fn reference_candidate(
    row: ReferenceEvidence,
    current_generation: &str,
    score: i64,
    why: &str,
) -> Candidate {
    let destination = row.dst_path.as_deref().unwrap_or("unresolved target");
    let destination_symbol = row.dst_symbol.as_deref().unwrap_or(&row.name);
    let target_identity = row.dst_symbol_id.as_deref().unwrap_or(destination_symbol);
    let freshness_override = reference_generation_freshness(&row, current_generation);
    let typed = is_typed_reference(&row.specifier);
    Candidate {
        id: format!(
            "reference:{}:{}:{}:{}:{}",
            row.src_path, row.src_line, row.src_column, row.specifier, target_identity
        ),
        kind: "reference".to_string(),
        title: format!(
            "{}:{} → {}#{}",
            row.src_path, row.src_line, destination, destination_symbol
        ),
        detail: format!("Resolved reference through {}", row.specifier),
        path: Some(row.src_path),
        symbol: row.src_symbol,
        start_line: Some(row.src_line.max(1)),
        end_line: Some(row.src_line.max(1)),
        // Reference rows belong to the caller. This lets the Node boundary
        // compare the live caller with the revision that produced the fact.
        evidence_sha: Some(row.content_sha.clone()),
        indexed_sha: Some(row.content_sha),
        evidence_meaning: None,
        indexed_meaning: None,
        provenance: if typed {
            "compiler-reference-index".to_string()
        } else {
            "import-reference-index".to_string()
        },
        certainty: if row.dst_path.is_some() {
            if typed {
                "exact".to_string()
            } else {
                "inferred".to_string()
            }
        } else {
            "unknown".to_string()
        },
        freshness_override,
        score,
        reasons: reason(why),
        is_test: row.is_test,
        source_backed: true,
    }
}

fn authored_candidate(
    connection: &Connection,
    kind: &str,
    source_id: &str,
    score: i64,
    why: &str,
    preferred_path: Option<&str>,
    preferred_symbol: Option<&str>,
) -> Result<Option<Candidate>> {
    match kind {
        "memory" => connection
            .query_row(
                "SELECT m.title, m.kind, m.body, m.source,
                        a.path, NULLIF(a.symbol, ''), a.content_sha,
                        f.content_sha, COALESCE(f.is_test, 0),
                        s.start_line, s.end_line, a.syntax_sha, f.syntax_sha
                 FROM memories m
                 LEFT JOIN memory_anchors a ON a.memory_id = m.id
                 LEFT JOIN files f ON f.path = a.path AND f.present = 1
                 LEFT JOIN symbols s ON s.path = a.path AND s.name = a.symbol
                                     AND a.symbol != ''
                 WHERE m.id = ?1 AND m.status = 'active'
                 ORDER BY CASE
                            WHEN a.path = ?2 AND a.symbol = ?3 THEN 0
                            WHEN a.path = ?2 THEN 1
                            ELSE 2
                          END,
                          a.path, a.symbol, s.start_line LIMIT 1",
                params![
                    source_id,
                    preferred_path.unwrap_or(""),
                    preferred_symbol.unwrap_or("")
                ],
                |row| {
                    let memory_kind: String = row.get(1)?;
                    Ok(Candidate {
                        id: format!("memory:{source_id}"),
                        kind: "memory".to_string(),
                        title: row.get(0)?,
                        detail: bounded_text(
                            &format!("{} · {}", memory_kind, row.get::<_, String>(2)?),
                            800,
                        ),
                        path: row.get(4)?,
                        symbol: row.get(5)?,
                        start_line: positive_line(row.get(9)?),
                        end_line: positive_line(row.get(10)?),
                        evidence_sha: row.get(6)?,
                        indexed_sha: row.get(7)?,
                        evidence_meaning: row.get(11)?,
                        indexed_meaning: row.get(12)?,
                        provenance: row.get(3)?,
                        certainty: "asserted".to_string(),
                        freshness_override: None,
                        score,
                        reasons: reason(why),
                        is_test: row.get::<_, i64>(8)? != 0,
                        source_backed: row.get::<_, Option<String>>(4)?.is_some(),
                    })
                },
            )
            .optional()
            .map_err(|error| database_error("Cannot read task-context memory evidence", error)),
        "finding" => connection
            .query_row(
                "SELECT findings.title, findings.severity, findings.description,
                        findings.suggestion, findings.path, findings.line_start,
                        findings.line_end, findings.content_sha, f2.content_sha,
                        COALESCE(f2.is_test, 0), findings.confidence, findings.source
                 FROM findings
                 LEFT JOIN files f2 ON f2.path = findings.path AND f2.present = 1
                 WHERE findings.id = ?1 AND findings.status IN ('open', 'regressed')",
                [source_id],
                |row| {
                    let description: String = row.get(2)?;
                    let suggestion: Option<String> = row.get(3)?;
                    Ok(Candidate {
                        id: format!("finding:{source_id}"),
                        kind: "finding".to_string(),
                        title: format!(
                            "[{}] {}",
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(0)?
                        ),
                        detail: bounded_text(
                            &match suggestion {
                                Some(suggestion) if !suggestion.is_empty() => {
                                    format!("{description} Suggested: {suggestion}")
                                }
                                _ => description,
                            },
                            800,
                        ),
                        path: row.get(4)?,
                        symbol: None,
                        start_line: positive_line(row.get(5)?),
                        end_line: positive_line(row.get(6)?),
                        evidence_sha: row.get(7)?,
                        indexed_sha: row.get(8)?,
                        evidence_meaning: None,
                        indexed_meaning: None,
                        provenance: row.get(11)?,
                        certainty: row.get(10)?,
                        freshness_override: None,
                        score,
                        reasons: reason(why),
                        is_test: row.get::<_, i64>(9)? != 0,
                        source_backed: row.get::<_, Option<String>>(4)?.is_some(),
                    })
                },
            )
            .optional()
            .map_err(|error| database_error("Cannot read task-context finding evidence", error)),
        "component" => connection
            .query_row(
                "SELECT name, kind, summary FROM components WHERE id = ?1",
                [source_id],
                |row| {
                    Ok(Candidate {
                        id: format!("component:{source_id}"),
                        kind: "component".to_string(),
                        title: row.get(0)?,
                        detail: bounded_text(
                            &format!(
                                "{} · {}",
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?
                            ),
                            800,
                        ),
                        path: None,
                        symbol: None,
                        start_line: None,
                        end_line: None,
                        evidence_sha: None,
                        indexed_sha: None,
                        evidence_meaning: None,
                        indexed_meaning: None,
                        provenance: "authored-map".to_string(),
                        certainty: "asserted".to_string(),
                        freshness_override: None,
                        score,
                        reasons: reason(why),
                        is_test: false,
                        source_backed: false,
                    })
                },
            )
            .optional()
            .map_err(|error| database_error("Cannot read task-context component", error)),
        "flow" => connection
            .query_row(
                "SELECT fl.name, fl.summary, fl.trigger, fs.path, fs.symbol,
                        fs.content_sha, fi.content_sha, COALESCE(fi.is_test, 0),
                        s.start_line, s.end_line, fs.syntax_sha, fi.syntax_sha
                 FROM flows fl
                 LEFT JOIN flow_steps fs ON fs.flow_id = fl.id
                 LEFT JOIN files fi ON fi.path = fs.path AND fi.present = 1
                 LEFT JOIN symbols s ON s.path = fs.path AND s.name = fs.symbol
                                     AND fs.symbol IS NOT NULL
                 WHERE fl.id = ?1
                 ORDER BY CASE
                            WHEN fs.path = ?2 AND fs.symbol = ?3 THEN 0
                            WHEN fs.path = ?2 THEN 1
                            ELSE 2
                          END,
                          fs.ordinal, s.start_line LIMIT 1",
                params![
                    source_id,
                    preferred_path.unwrap_or(""),
                    preferred_symbol.unwrap_or("")
                ],
                |row| {
                    let summary: String = row.get(1)?;
                    let trigger: Option<String> = row.get(2)?;
                    let path: Option<String> = row.get(3)?;
                    Ok(Candidate {
                        id: format!("flow:{source_id}"),
                        kind: "flow".to_string(),
                        title: row.get(0)?,
                        detail: bounded_text(
                            &match trigger {
                                Some(trigger) if !trigger.is_empty() => {
                                    format!("{summary} Trigger: {trigger}")
                                }
                                _ => summary,
                            },
                            800,
                        ),
                        path: path.clone(),
                        symbol: row.get(4)?,
                        start_line: positive_line(row.get(8)?),
                        end_line: positive_line(row.get(9)?),
                        evidence_sha: row.get(5)?,
                        indexed_sha: row.get(6)?,
                        evidence_meaning: row.get(10)?,
                        indexed_meaning: row.get(11)?,
                        provenance: "authored-map".to_string(),
                        certainty: "asserted".to_string(),
                        freshness_override: None,
                        score,
                        reasons: reason(why),
                        is_test: row.get::<_, i64>(7)? != 0,
                        source_backed: path.is_some(),
                    })
                },
            )
            .optional()
            .map_err(|error| database_error("Cannot read task-context flow", error)),
        "relation" => connection
            .query_row(
                "SELECT COALESCE(r.label, r.kind), r.evidence, r.src_path, r.src_symbol,
                        r.evidence_line, r.content_sha, f.content_sha, COALESCE(f.is_test, 0),
                        r.confidence, r.source, r.syntax_sha, f.syntax_sha
                 FROM relations r LEFT JOIN files f ON f.path = r.src_path AND f.present = 1
                 WHERE r.id = ?1",
                [source_id],
                |row| {
                    let line = positive_line(row.get(4)?);
                    Ok(Candidate {
                        id: format!("relation:{source_id}"),
                        kind: "relation".to_string(),
                        title: row.get(0)?,
                        detail: bounded_text(&row.get::<_, String>(1)?, 800),
                        path: Some(row.get(2)?),
                        symbol: row.get(3)?,
                        start_line: line,
                        end_line: line,
                        evidence_sha: row.get(5)?,
                        indexed_sha: row.get(6)?,
                        evidence_meaning: row.get(10)?,
                        indexed_meaning: row.get(11)?,
                        provenance: row.get(9)?,
                        certainty: row.get(8)?,
                        freshness_override: None,
                        score,
                        reasons: reason(why),
                        is_test: row.get::<_, i64>(7)? != 0,
                        source_backed: true,
                    })
                },
            )
            .optional()
            .map_err(|error| database_error("Cannot read task-context relation", error)),
        _ => Ok(None),
    }
}

fn execution_candidate(
    connection: &Connection,
    entry_id: &str,
    score: i64,
    why: &str,
) -> Result<Option<Candidate>> {
    connection
        .query_row(
            "SELECT e.id, e.kind, e.label, e.method, e.route, e.path, e.symbol,
                    e.start_line, e.end_line, e.certainty, e.input_sha,
                    f.content_sha, f.is_test
             FROM execution_entries e JOIN files f ON f.path = e.path AND f.present = 1
             WHERE e.id = ?1",
            [entry_id],
            |row| {
                let method: String = row.get(3)?;
                let route: String = row.get(4)?;
                let label: String = row.get(2)?;
                Ok(Candidate {
                    id: format!("execution:{}", row.get::<_, String>(0)?),
                    kind: "execution".to_string(),
                    title: if route.is_empty() {
                        label
                    } else {
                        format!("{} {}", method, route).trim().to_string()
                    },
                    detail: format!("{} entry point", row.get::<_, String>(1)?),
                    path: Some(row.get(5)?),
                    symbol: Some(row.get::<_, String>(6)?).filter(|value| !value.is_empty()),
                    start_line: positive_line(Some(row.get(7)?)),
                    end_line: positive_line(Some(row.get(8)?)),
                    evidence_sha: Some(row.get(10)?),
                    indexed_sha: Some(row.get(11)?),
                    evidence_meaning: None,
                    indexed_meaning: None,
                    provenance: "framework-adapter".to_string(),
                    certainty: row.get(9)?,
                    freshness_override: None,
                    score,
                    reasons: reason(why),
                    is_test: row.get::<_, i64>(12)? != 0,
                    source_backed: true,
                })
            },
        )
        .optional()
        .map_err(|error| database_error("Cannot read task-context execution entry", error))
}

fn exact_or_suffix_paths(connection: &Connection, target: &str) -> Result<Vec<String>> {
    let exact = connection
        .query_row(
            "SELECT path FROM files WHERE present = 1 AND path = ?1",
            [target],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| database_error("Cannot resolve exact task-context target path", error))?;
    if let Some(exact) = exact {
        return Ok(vec![exact]);
    }

    let escaped = target
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let suffix = format!("%/{escaped}");
    let mut statement = connection
        .prepare(
            "SELECT path FROM files
             WHERE present = 1 AND path LIKE ?1 ESCAPE '\\'
             ORDER BY length(path), path LIMIT 9",
        )
        .map_err(|error| database_error("Cannot resolve task-context target path", error))?;
    let rows = statement
        .query_map([suffix], |row| row.get::<_, String>(0))
        .map_err(|error| database_error("Cannot resolve task-context target path", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read task-context target paths", error))?;
    Ok(rows)
}

fn exact_symbols(connection: &Connection, target: &str) -> Result<Vec<(String, String, String)>> {
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.path, s.name FROM symbols s
             JOIN files f ON f.path = s.path
             WHERE f.present = 1 AND (s.id = ?1 OR s.name = ?1)
             ORDER BY CASE WHEN s.id = ?1 THEN 0 ELSE 1 END, s.exported DESC, s.path, s.start_line
             LIMIT 9",
        )
        .map_err(|error| database_error("Cannot resolve task-context target symbol", error))?;
    let rows = statement
        .query_map([target], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|error| database_error("Cannot resolve task-context target symbol", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read task-context target symbols", error))?;
    Ok(rows)
}

#[derive(Default)]
struct ExplicitTargets {
    files: BTreeSet<String>,
    symbols: BTreeMap<String, BTreeSet<String>>,
}

fn resolve_targets(
    connection: &Connection,
    candidates: &mut CandidateSet,
    targets: &[String],
    seed_paths: &mut BTreeSet<String>,
    seed_symbols: &mut BTreeSet<String>,
    seed_anchor_symbols: &mut BTreeMap<String, String>,
    explicit_targets: &mut ExplicitTargets,
) -> Result<Vec<Value>> {
    let mut resolutions = Vec::new();
    for raw in targets {
        let target = raw.trim().replace('\\', "/");
        let target = target.strip_prefix("./").unwrap_or(&target);
        let paths = exact_or_suffix_paths(connection, target)?;
        if paths.len() == 1 {
            let path = paths[0].clone();
            seed_paths.insert(path.clone());
            explicit_targets.files.insert(path.clone());
            add_file(
                connection,
                candidates,
                &path,
                EXPLICIT_FILE_SCORE,
                "explicit target",
            )?;
            resolutions.push(json!({
                "query": raw,
                "status": "resolved",
                "kind": "file",
                "id": format!("file:{path}"),
                "path": path,
                "symbol": Value::Null,
            }));
            continue;
        }
        if paths.len() > 1 {
            resolutions.push(json!({
                "query": raw,
                "status": "ambiguous",
                "kind": "file",
                "candidates": paths,
            }));
            continue;
        }

        let symbols = exact_symbols(connection, target)?;
        if symbols.len() == 1 {
            let (id, path, name) = symbols[0].clone();
            seed_paths.insert(path.clone());
            seed_symbols.insert(id.clone());
            explicit_targets
                .symbols
                .entry(path.clone())
                .or_default()
                .insert(id.clone());
            seed_anchor_symbols
                .entry(path.clone())
                .or_insert_with(|| name.clone());
            add_symbol(
                connection,
                candidates,
                &id,
                EXPLICIT_SYMBOL_SCORE,
                "explicit target",
            )?;
            resolutions.push(json!({
                "query": raw,
                "status": "resolved",
                "kind": "symbol",
                "id": format!("symbol:{id}"),
                "path": path,
                "symbol": name,
            }));
        } else if symbols.len() > 1 {
            resolutions.push(json!({
                "query": raw,
                "status": "ambiguous",
                "kind": "symbol",
                "candidates": symbols.into_iter().map(|(id, _, _)| id).collect::<Vec<_>>(),
            }));
        } else {
            resolutions.push(json!({
                "query": raw,
                "status": "not-found",
                "candidates": [],
            }));
        }
    }
    Ok(resolutions)
}

#[derive(Debug)]
struct SeedAnchor {
    path: String,
    symbol: Option<String>,
}

fn authored_seed_anchors(
    connection: &Connection,
    kind: &str,
    source_id: &str,
    limit: usize,
    omissions: &mut RetrievalOmissions,
) -> Result<Vec<SeedAnchor>> {
    let sql = match kind {
        "memory" => {
            "SELECT a.path, NULLIF(a.symbol, ''), COUNT(*) OVER()
             FROM memory_anchors a
             JOIN files f ON f.path = a.path AND f.present = 1
             WHERE a.memory_id = ?1
             ORDER BY a.path, a.symbol LIMIT ?2"
        }
        "flow" => {
            "SELECT anchor.path, anchor.symbol, COUNT(*) OVER()
             FROM (
               SELECT DISTINCT fs.path AS path, NULLIF(fs.symbol, '') AS symbol
               FROM flow_steps fs
               JOIN files f ON f.path = fs.path AND f.present = 1
               WHERE fs.flow_id = ?1 AND fs.path IS NOT NULL
             ) anchor
             ORDER BY anchor.path, anchor.symbol LIMIT ?2"
        }
        "relation" => {
            "SELECT anchor.path, anchor.symbol, COUNT(*) OVER()
             FROM (
               SELECT src_path AS path, NULLIF(src_symbol, '') AS symbol
               FROM relations WHERE id = ?1
               UNION
               SELECT dst_path AS path, NULLIF(dst_symbol, '') AS symbol
               FROM relations WHERE id = ?1 AND dst_path IS NOT NULL
             ) anchor
             JOIN files f ON f.path = anchor.path AND f.present = 1
             ORDER BY anchor.path, anchor.symbol LIMIT ?2"
        }
        "finding" => {
            "SELECT findings.path, NULL, COUNT(*) OVER()
             FROM findings
             JOIN files f ON f.path = findings.path AND f.present = 1
             WHERE findings.id = ?1 AND findings.path IS NOT NULL
             LIMIT ?2"
        }
        "component" => {
            "SELECT snapshot.path, NULL, COUNT(*) OVER()
             FROM component_snapshot snapshot
             JOIN files f ON f.path = snapshot.path AND f.present = 1
             WHERE snapshot.component_id = ?1
             ORDER BY snapshot.path LIMIT ?2"
        }
        _ => return Ok(Vec::new()),
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| database_error("Cannot prepare authored task anchors", error))?;
    let rows = statement
        .query_map(
            params![source_id, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| {
                Ok((
                    SeedAnchor {
                        path: row.get(0)?,
                        symbol: row.get(1)?,
                    },
                    usize::try_from(row.get::<_, i64>(2)?).unwrap_or(usize::MAX),
                ))
            },
        )
        .map_err(|error| database_error("Cannot find authored task anchors", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read authored task anchors", error))?;
    let total = rows.first().map_or(0, |row| row.1);
    omissions.candidates += total.saturating_sub(rows.len());
    Ok(rows.into_iter().map(|row| row.0).collect())
}

fn add_lexical_candidates(
    connection: &Connection,
    candidates: &mut CandidateSet,
    query: &str,
    seed_paths: &mut BTreeSet<String>,
    seed_symbols: &mut BTreeSet<String>,
    seed_anchor_symbols: &mut BTreeMap<String, String>,
    omissions: &mut RetrievalOmissions,
) -> Result<()> {
    if query.trim().is_empty() {
        return Ok(());
    }
    let hits: Vec<Value> = serde_json::from_str(&search_knowledge_json(
        connection, query, "[]", 40, None,
    )?)
    .map_err(|error| invalid_argument(format!("Cannot decode native knowledge search: {error}")))?;
    for (rank, hit) in hits.iter().enumerate() {
        let Some(kind) = hit.get("kind").and_then(Value::as_str) else {
            continue;
        };
        let Some(source_id) = hit.get("source_id").and_then(Value::as_str) else {
            continue;
        };
        let score = 900_i64.saturating_sub(i64::try_from(rank).unwrap_or(40) * 7);
        match kind {
            "file" => {
                add_file(
                    connection,
                    candidates,
                    source_id,
                    score,
                    "task lexical match",
                )?;
                if rank < 6 {
                    seed_paths.insert(source_id.to_string());
                }
            }
            "symbol" => {
                add_symbol(
                    connection,
                    candidates,
                    source_id,
                    score,
                    "task lexical match",
                )?;
                if rank < 6 {
                    seed_symbols.insert(source_id.to_string());
                    if let Some(path) = hit.get("path").and_then(Value::as_str) {
                        if !path.is_empty() {
                            seed_paths.insert(path.to_string());
                            if let Some(symbol) = hit.get("symbol").and_then(Value::as_str) {
                                if !symbol.is_empty() {
                                    seed_anchor_symbols
                                        .entry(path.to_string())
                                        .or_insert_with(|| symbol.to_string());
                                }
                            }
                        }
                    }
                }
            }
            _ => {
                if let Some(candidate) = authored_candidate(
                    connection,
                    kind,
                    source_id,
                    score,
                    "task lexical match",
                    None,
                    None,
                )? {
                    if rank < 6 {
                        let anchors =
                            authored_seed_anchors(connection, kind, source_id, 20, omissions)?;
                        if anchors.is_empty() {
                            if let Some(path) = candidate.path.as_ref() {
                                seed_paths.insert(path.clone());
                                if let Some(symbol) = candidate.symbol.as_ref() {
                                    seed_anchor_symbols
                                        .entry(path.clone())
                                        .or_insert_with(|| symbol.clone());
                                }
                            }
                        }
                        for anchor in anchors {
                            seed_paths.insert(anchor.path.clone());
                            if let Some(symbol) = anchor.symbol {
                                seed_anchor_symbols.entry(anchor.path).or_insert(symbol);
                            }
                        }
                    }
                    candidates.insert(candidate);
                }
            }
        }
    }
    Ok(())
}

fn lexical_task_query(task: &str, intent: &str) -> String {
    let tokens = task
        .split_whitespace()
        .filter(|token| {
            token
                .trim_matches(|character: char| !character.is_alphanumeric())
                .to_lowercase()
                != intent
        })
        .collect::<Vec<_>>();
    let generic_change_request = tokens.iter().all(|token| {
        matches!(
            token
                .trim_matches(|character: char| !character.is_alphanumeric())
                .to_lowercase()
                .as_str(),
            "the" | "current" | "working" | "tree" | "change" | "changes"
        )
    });
    if generic_change_request {
        String::new()
    } else {
        tokens.join(" ")
    }
}

fn collect_strings(
    connection: &Connection,
    sql: &str,
    parameter: &str,
    limit: usize,
    omissions: &mut RetrievalOmissions,
    context: &str,
) -> Result<Vec<String>> {
    // Collection caps keep graph expansion bounded, but they must not disappear
    // silently. Callers return one row per candidate identity in deterministic
    // priority order so duplicate anchors do not masquerade as omitted facts.
    let total = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM ({sql}) AS bounded_candidates"),
            [parameter],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| database_error(context, error))?;
    let mut statement = connection
        .prepare(&format!("{sql} LIMIT ?2"))
        .map_err(|error| database_error(context, error))?;
    let rows = statement
        .query_map(
            params![parameter, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| database_error(context, error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error(context, error))?;
    omissions.candidates += usize::try_from(total)
        .unwrap_or(usize::MAX)
        .saturating_sub(rows.len());
    Ok(rows)
}

fn add_change_candidates(
    connection: &Connection,
    candidates: &mut CandidateSet,
    omissions: &mut RetrievalOmissions,
    seed_paths: &mut BTreeSet<String>,
    historical_seed_paths: &mut BTreeSet<String>,
    input: &ChangeInput,
) -> Result<Vec<ChangeEvidence>> {
    if input.state != "available" || input.changes.is_empty() {
        return Ok(Vec::new());
    }
    struct ClassifiedChange {
        change: ChangeSeed,
        current: Option<FileMeta>,
        historical: Option<FileMeta>,
    }

    let lexical_paths = seed_paths.clone();
    let mut changes = Vec::with_capacity(input.changes.len());
    for change in &input.changes {
        // The watcher updates the inventory asynchronously. Porcelain's index
        // deletion does not prove the worktree path is gone (`git rm --cached`
        // can leave an ignored live file), so prefer the detector's bounded
        // filesystem observation. Older callers without that field retain the
        // conservative status fallback below.
        // A staged deletion followed by an untracked recreation produces two
        // porcelain records for one live path (`D.` plus `?`). The merged
        // worktree `?` is positive evidence that the path exists even though
        // the index still records a deletion.
        let recreated_live_path = change.worktree_status.contains('?')
            || change
                .status
                .split(" + ")
                .any(|status| status == "untracked");
        let removes_live_path = change.worktree_path_present.map_or_else(
            || {
                !recreated_live_path
                    && (change.index_status.contains('D')
                        || change.worktree_status.contains('D')
                        || change.status.contains("deleted"))
            },
            |present| !present,
        );
        let current = if removes_live_path {
            None
        } else {
            file_meta(connection, &change.path)?
        };
        let historical = if current.is_none() {
            if let Some(previous_path) = change.previous_path.as_deref() {
                historical_file_meta(connection, previous_path)?
                    .or(historical_file_meta(connection, &change.path)?)
            } else {
                historical_file_meta(connection, &change.path)?
            }
        } else {
            None
        };
        changes.push(ClassifiedChange {
            change: change.clone(),
            current,
            historical,
        });
    }
    changes.sort_by(|left, right| {
        let state_rank = |change: &ClassifiedChange| {
            if change.current.is_some() {
                0
            } else if change.historical.is_some() {
                1
            } else {
                2
            }
        };
        state_rank(left)
            .cmp(&state_rank(right))
            .then_with(|| {
                (!lexical_paths.contains(&left.change.path))
                    .cmp(&(!lexical_paths.contains(&right.change.path)))
            })
            .then_with(|| left.change.path.cmp(&right.change.path))
    });
    let selected = changes
        .into_iter()
        .take(MAX_CHANGE_SEEDS)
        .collect::<Vec<_>>();
    let mut considered = Vec::with_capacity(selected.len());
    for classified in selected {
        let change = classified.change;
        // Change state is a primary signal for a generic change-review task.
        // When lexical retrieval found concrete task paths, unrelated dirty
        // files remain useful context but must not crowd those paths out of a
        // small brief.
        let task_aligned = lexical_paths.is_empty()
            || lexical_paths.contains(&change.path)
            || change
                .previous_path
                .as_ref()
                .is_some_and(|path| lexical_paths.contains(path));
        let change_file_score = if task_aligned {
            CHANGE_FILE_SCORE
        } else {
            UNRELATED_CHANGE_FILE_SCORE
        };
        let change_symbol_score = if task_aligned {
            CHANGE_SYMBOL_SCORE
        } else {
            UNRELATED_CHANGE_SYMBOL_SCORE
        };
        let index_state = if let Some(file) = classified.current {
            candidates.insert(file_candidate(
                &file,
                change_file_score,
                "changed in working tree",
            ));
            for symbol_id in collect_strings(
                connection,
                "SELECT id FROM symbols WHERE path = ?1 ORDER BY start_line, id",
                &change.path,
                30,
                omissions,
                "Cannot find declarations in changed task path",
            )? {
                add_symbol(
                    connection,
                    candidates,
                    &symbol_id,
                    change_symbol_score,
                    "declared in changed working-tree path",
                )?;
            }
            seed_paths.insert(change.path.clone());
            "current"
        } else if let Some(file) = classified.historical {
            candidates.insert(historical_change_candidate(
                &file,
                &change,
                input
                    .source
                    .as_deref()
                    .unwrap_or("working-tree-change-input"),
                change_file_score,
            ));
            seed_paths.insert(file.path.clone());
            historical_seed_paths.insert(file.path.clone());
            "historical"
        } else {
            "absent"
        };
        considered.push(ChangeEvidence {
            change,
            index_state,
        });
    }
    Ok(considered)
}

fn add_covering_tests(
    connection: &Connection,
    candidates: &mut CandidateSet,
    omissions: &mut RetrievalOmissions,
    path: &str,
    current_generation: &str,
    destination_symbol_id: Option<&str>,
) -> Result<()> {
    let unscoped_sql = "WITH ranked AS (
           SELECT r.src_path, r.src_line, r.src_column, NULLIF(r.src_symbol, '') AS src_symbol,
                  r.name, r.specifier, r.dst_path, r.dst_symbol_id, s.name AS dst_symbol,
                  f.content_sha, f.ref_generation, f.ref_source_signature, f.is_test,
                  ROW_NUMBER() OVER (
                    PARTITION BY r.src_path
                    ORDER BY r.src_line, r.src_column, r.name, r.specifier
                  ) AS source_rank
           FROM refs r
           JOIN files f ON f.path = r.src_path AND f.present = 1
           LEFT JOIN symbols s ON s.id = r.dst_symbol_id
           WHERE r.dst_path = ?1 AND r.src_path != ?1 AND f.is_test = 1
         )
         SELECT src_path, src_line, src_column, src_symbol, name, specifier,
                dst_path, dst_symbol_id, dst_symbol, content_sha,
                ref_generation, ref_source_signature, is_test,
                COUNT(*) OVER()
         FROM ranked WHERE source_rank = 1
         ORDER BY src_path LIMIT ?2";
    let scoped_sql = "WITH ranked AS (
           SELECT r.src_path, r.src_line, r.src_column, NULLIF(r.src_symbol, '') AS src_symbol,
                  r.name, r.specifier, r.dst_path, r.dst_symbol_id, s.name AS dst_symbol,
                  f.content_sha, f.ref_generation, f.ref_source_signature, f.is_test,
                  ROW_NUMBER() OVER (
                    PARTITION BY r.src_path
                    ORDER BY r.src_line, r.src_column, r.name, r.specifier
                  ) AS source_rank
           FROM refs r
           JOIN files f ON f.path = r.src_path AND f.present = 1
           LEFT JOIN symbols s ON s.id = r.dst_symbol_id
           WHERE r.dst_path = ?1 AND r.src_path != ?1 AND f.is_test = 1
             AND r.dst_symbol_id = ?3
         )
         SELECT src_path, src_line, src_column, src_symbol, name, specifier,
                dst_path, dst_symbol_id, dst_symbol, content_sha,
                ref_generation, ref_source_signature, is_test,
                COUNT(*) OVER()
         FROM ranked WHERE source_rank = 1
         ORDER BY src_path LIMIT ?2";
    let sql = if destination_symbol_id.is_some() {
        scoped_sql
    } else {
        unscoped_sql
    };
    let (covering_tests, tests_omitted) = collect_reference_evidence(
        connection,
        sql,
        path,
        100,
        destination_symbol_id,
        "Cannot find covering tests for task target",
    )?;
    omissions.candidates += tests_omitted;
    for test in covering_tests {
        candidates.insert(reference_candidate(
            test,
            current_generation,
            780,
            "covering test reference",
        ));
    }
    Ok(())
}

fn expand_path(
    connection: &Connection,
    candidates: &mut CandidateSet,
    omissions: &mut RetrievalOmissions,
    path: &str,
    preferred_symbol: Option<&str>,
    explicit_symbol_targets: Option<&BTreeSet<String>>,
) -> Result<()> {
    let current_generation = typed_workspace_generation(connection)?;
    for id in collect_strings(
        connection,
        "SELECT DISTINCT m.id FROM memories m JOIN memory_anchors a ON a.memory_id = m.id
         WHERE a.path = ?1 AND m.status = 'active' ORDER BY m.updated_at DESC, m.id",
        path,
        20,
        omissions,
        "Cannot find memories anchored to task target",
    )? {
        if let Some(candidate) = authored_candidate(
            connection,
            "memory",
            &id,
            1_020,
            "recorded against target",
            Some(path),
            preferred_symbol,
        )? {
            candidates.insert(candidate);
        }
    }
    for id in collect_strings(
        connection,
        "SELECT id FROM findings WHERE path = ?1 AND status IN ('open', 'regressed')
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                  line_start",
        path,
        20,
        omissions,
        "Cannot find findings for task target",
    )? {
        if let Some(candidate) = authored_candidate(
            connection,
            "finding",
            &id,
            1_010,
            "open finding on target",
            Some(path),
            preferred_symbol,
        )? {
            candidates.insert(candidate);
        }
    }
    for id in collect_strings(
        connection,
        "SELECT DISTINCT fl.id FROM flows fl JOIN flow_steps fs ON fs.flow_id = fl.id
         WHERE fs.path = ?1 ORDER BY fl.updated_at DESC",
        path,
        12,
        omissions,
        "Cannot find authored flows for task target",
    )? {
        if let Some(candidate) = authored_candidate(
            connection,
            "flow",
            &id,
            930,
            "authored flow crosses target",
            Some(path),
            preferred_symbol,
        )? {
            candidates.insert(candidate);
        }
    }
    for id in collect_strings(
        connection,
        "SELECT DISTINCT r.id FROM relations r
         WHERE r.src_path = ?1 OR r.dst_path = ?1 ORDER BY r.updated_at DESC",
        path,
        20,
        omissions,
        "Cannot find asserted relations for task target",
    )? {
        if let Some(candidate) = authored_candidate(
            connection,
            "relation",
            &id,
            820,
            "asserted relation touches target",
            Some(path),
            preferred_symbol,
        )? {
            candidates.insert(candidate);
        }
    }
    for id in collect_strings(
        connection,
        "SELECT DISTINCT e.id FROM execution_entries e
         LEFT JOIN execution_nodes n ON n.entry_id = e.id
         WHERE e.path = ?1 OR n.path = ?1 OR n.target_path = ?1
         ORDER BY e.path, e.start_line",
        path,
        20,
        omissions,
        "Cannot find execution entries for task target",
    )? {
        if let Some(candidate) = execution_candidate(
            connection,
            &id,
            900,
            "deterministic execution path touches target",
        )? {
            candidates.insert(candidate);
        }
    }

    add_dependency_candidates(connection, candidates, omissions, path)?;
    for importer in collect_strings(
        connection,
        "SELECT DISTINCT src_path FROM edges WHERE dst_path = ?1 ORDER BY src_path",
        path,
        24,
        omissions,
        "Cannot find direct task importers",
    )? {
        add_file(connection, candidates, &importer, 700, "direct importer")?;
    }
    for symbol_id in collect_strings(
        connection,
        "SELECT id FROM symbols WHERE path = ?1 AND exported = 1 ORDER BY start_line",
        path,
        30,
        omissions,
        "Cannot find exported target symbols",
    )? {
        add_symbol(
            connection,
            candidates,
            &symbol_id,
            960,
            "exported surface of target",
        )?;
    }
    let (outgoing, outgoing_omitted) = collect_reference_evidence(
        connection,
        "SELECT r.src_path, r.src_line, r.src_column, NULLIF(r.src_symbol, ''),
                r.name, r.specifier, r.dst_path, r.dst_symbol_id, s.name,
                f.content_sha, f.ref_generation, f.ref_source_signature,
                f.is_test, COUNT(*) OVER()
         FROM refs r
         JOIN files f ON f.path = r.src_path AND f.present = 1
         LEFT JOIN symbols s ON s.id = r.dst_symbol_id
         WHERE r.src_path = ?1 AND r.dst_path IS NOT NULL
         ORDER BY r.src_line, r.src_column, r.name, r.specifier LIMIT ?2",
        path,
        30,
        None,
        "Cannot find references produced by task target",
    )?;
    omissions.candidates += outgoing_omitted;
    for reference in outgoing {
        let destination_symbol = reference.dst_symbol_id.clone();
        candidates.insert(reference_candidate(
            reference,
            &current_generation,
            760,
            "reference produced by target",
        ));
        if let Some(destination_symbol) = destination_symbol {
            add_symbol(
                connection,
                candidates,
                &destination_symbol,
                720,
                "referenced declaration",
            )?;
        }
    }

    let (callers, callers_omitted) = collect_reference_evidence(
        connection,
        "WITH ranked AS (
           SELECT r.src_path, r.src_line, r.src_column, NULLIF(r.src_symbol, '') AS src_symbol,
                  r.name, r.specifier, r.dst_path, r.dst_symbol_id, s.name AS dst_symbol,
                  f.content_sha, f.ref_generation, f.ref_source_signature, f.is_test,
                  ROW_NUMBER() OVER (
                    PARTITION BY r.src_path
                    ORDER BY r.src_line, r.src_column, r.name, r.specifier
                  ) AS source_rank
           FROM refs r
           JOIN files f ON f.path = r.src_path AND f.present = 1
           LEFT JOIN symbols s ON s.id = r.dst_symbol_id
           WHERE r.dst_path = ?1 AND r.src_path != ?1 AND f.is_test = 0
         )
         SELECT src_path, src_line, src_column, src_symbol, name, specifier,
                dst_path, dst_symbol_id, dst_symbol, content_sha,
                ref_generation, ref_source_signature, is_test,
                COUNT(*) OVER()
         FROM ranked WHERE source_rank = 1
         ORDER BY src_path LIMIT ?2",
        path,
        30,
        None,
        "Cannot find line-backed callers of task target",
    )?;
    omissions.candidates += callers_omitted;
    for caller in callers {
        candidates.insert(reference_candidate(
            caller,
            &current_generation,
            740,
            "tracked caller of target",
        ));
    }

    // Covering tests are not a page of ordinary callers. Retrieve one exact
    // call site per test independently so a test that sorts after a caller cap
    // cannot disappear before intent ranking sees it.
    if let Some(symbol_ids) = explicit_symbol_targets.filter(|ids| !ids.is_empty()) {
        for symbol_id in symbol_ids {
            add_covering_tests(
                connection,
                candidates,
                omissions,
                path,
                &current_generation,
                Some(symbol_id),
            )?;
        }
    } else {
        add_covering_tests(
            connection,
            candidates,
            omissions,
            path,
            &current_generation,
            None,
        )?;
    }
    Ok(())
}

fn expand_symbol(
    connection: &Connection,
    candidates: &mut CandidateSet,
    omissions: &mut RetrievalOmissions,
    symbol_id: &str,
) -> Result<()> {
    for callee in collect_strings(
        connection,
        "SELECT DISTINCT dst_symbol_id FROM refs
         WHERE src_symbol_id = ?1 AND dst_symbol_id IS NOT NULL ORDER BY dst_symbol_id",
        symbol_id,
        30,
        omissions,
        "Cannot find task symbol callees",
    )? {
        add_symbol(
            connection,
            candidates,
            &callee,
            800,
            "called by target symbol",
        )?;
    }
    for caller in collect_strings(
        connection,
        "SELECT DISTINCT src_symbol_id FROM refs
         WHERE dst_symbol_id = ?1 AND src_symbol_id IS NOT NULL ORDER BY src_symbol_id",
        symbol_id,
        30,
        omissions,
        "Cannot find task symbol callers",
    )? {
        add_symbol(connection, candidates, &caller, 820, "calls target symbol")?;
    }
    Ok(())
}

fn parse_inputs(
    task: &str,
    targets_json: &str,
    intent: Option<&str>,
) -> Result<(String, Vec<String>, String)> {
    let task = task.trim().to_string();
    if task.len() > MAX_TASK_BYTES {
        return Err(invalid_argument(format!(
            "Task exceeds the {MAX_TASK_BYTES}-byte retrieval limit"
        )));
    }
    let targets: Vec<String> = serde_json::from_str(targets_json)
        .map_err(|error| invalid_argument(format!("Invalid task-context targets: {error}")))?;
    if targets.len() > MAX_TARGETS {
        return Err(invalid_argument(format!(
            "Task context accepts at most {MAX_TARGETS} explicit targets"
        )));
    }
    let mut seen = HashSet::new();
    let targets = targets
        .into_iter()
        .map(|target| target.trim().to_string())
        .filter(|target| !target.is_empty())
        .map(|target| {
            if target.len() > MAX_TARGET_BYTES {
                Err(invalid_argument(format!(
                    "Target exceeds the {MAX_TARGET_BYTES}-byte retrieval limit"
                )))
            } else {
                Ok(target)
            }
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|target| seen.insert(target.clone()))
        .collect::<Vec<_>>();
    if task.is_empty() && targets.is_empty() {
        return Err(invalid_argument(
            "Task context requires a task, an explicit target, or both",
        ));
    }
    let intent = intent.unwrap_or("understand").trim().to_lowercase();
    if !INTENTS.contains(&intent.as_str()) {
        return Err(invalid_argument(format!(
            "Unknown task intent {intent}. Expected one of: {}",
            INTENTS.join(", ")
        )));
    }
    Ok((task, targets, intent))
}

fn incoming_reference_coverage(connection: &Connection) -> Result<&'static str> {
    let (files, unavailable, import_only): (i64, i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN ref_coverage = 'none' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN ref_coverage = 'import' THEN 1 ELSE 0 END), 0)
             FROM files
             WHERE present = 1 AND lang IN ('typescript', 'javascript', 'python')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| database_error("Cannot assess task-context reference coverage", error))?;
    if files == 0 || unavailable > 0 {
        Ok("none")
    } else if import_only > 0 {
        Ok("import")
    } else {
        Ok("typed")
    }
}

pub(crate) fn task_context_json(
    connection: &Connection,
    task: &str,
    targets_json: &str,
    intent: Option<&str>,
    limit: u32,
    changes_json: Option<&str>,
) -> Result<String> {
    let (task, targets, intent) = parse_inputs(task, targets_json, intent)?;
    let change_input = parse_change_input(changes_json)?;
    let limit = limit.clamp(1, 100) as usize;
    let mut candidates = CandidateSet::default();
    let mut retrieval_omissions = RetrievalOmissions::default();
    let mut seed_paths = BTreeSet::new();
    let mut historical_seed_paths = BTreeSet::new();
    let mut seed_symbols = BTreeSet::new();
    // First writer wins: explicit targets are resolved before lexical hits, so
    // a same-file memory match cannot replace the symbol the caller named.
    let mut seed_anchor_symbols = BTreeMap::<String, String>::new();
    let mut explicit_targets = ExplicitTargets::default();
    let resolutions = resolve_targets(
        connection,
        &mut candidates,
        &targets,
        &mut seed_paths,
        &mut seed_symbols,
        &mut seed_anchor_symbols,
        &mut explicit_targets,
    )?;
    let lexical_query = lexical_task_query(&task, &intent);
    add_lexical_candidates(
        connection,
        &mut candidates,
        &lexical_query,
        &mut seed_paths,
        &mut seed_symbols,
        &mut seed_anchor_symbols,
        &mut retrieval_omissions,
    )?;
    let considered_changes = add_change_candidates(
        connection,
        &mut candidates,
        &mut retrieval_omissions,
        &mut seed_paths,
        &mut historical_seed_paths,
        &change_input,
    )?;
    for path in &seed_paths {
        let preferred_symbol = seed_anchor_symbols.get(path).map(String::as_str);
        // A file target asks for the whole file even when the caller also names
        // one symbol in it. Symbol-only requests remain scoped so sibling tests
        // do not displace evidence for the requested declaration.
        let symbol_scope = if explicit_targets.files.contains(path) {
            None
        } else {
            explicit_targets.symbols.get(path)
        };
        expand_path(
            connection,
            &mut candidates,
            &mut retrieval_omissions,
            path,
            preferred_symbol,
            symbol_scope,
        )?;
    }
    for symbol in &seed_symbols {
        expand_symbol(
            connection,
            &mut candidates,
            &mut retrieval_omissions,
            symbol,
        )?;
    }
    for path in historical_seed_paths {
        candidates.mark_path_stale(
            &path,
            "working-tree path changed before the source inventory refreshed",
        );
    }

    let mut uncertainties = Vec::new();
    match incoming_reference_coverage(connection)? {
        "none" => uncertainties.push(
            "At least one indexed source file has no reference analysis; zero callers or tests means unknown, not unused."
                .to_string(),
        ),
        "import" => uncertainties.push(
            "Reference coverage is at most import-resolved across the workspace; method calls and type positions can be incomplete."
                .to_string(),
        ),
        _ => {}
    }
    if resolutions
        .iter()
        .any(|resolution| resolution["status"] == "ambiguous")
    {
        uncertainties.push(
            "At least one explicit target is ambiguous and was not guessed; refine it to add graph neighbours."
                .to_string(),
        );
    }
    if resolutions
        .iter()
        .any(|resolution| resolution["status"] == "not-found")
    {
        uncertainties.push(
            "At least one explicit target is not in the current index; task search results remain available."
                .to_string(),
        );
    }
    match change_input.state.as_str() {
        "not-repository" => uncertainties.push(
            "Working-tree change relevance is unavailable because this project is not a Git work tree."
                .to_string(),
        ),
        "unavailable" => uncertainties.push(
            "Working-tree change relevance is unavailable; lexical and graph retrieval remain active."
                .to_string(),
        ),
        _ => {}
    }
    if change_input.truncated
        || change_input.detected_paths > considered_changes.len()
        || considered_changes
            .iter()
            .any(|change| change.index_state != "current")
    {
        uncertainties.push(
            "Working-tree change expansion was bounded or included historical/unindexed paths; inspect changeContext before treating it as complete."
                .to_string(),
        );
    }

    let (ranked, ranked_omissions) = candidates.ranked(&intent, limit);
    let omitted_candidates = ranked_omissions.saturating_add(retrieval_omissions.candidates);
    let candidate_values = ranked
        .into_iter()
        .map(Candidate::into_value)
        .collect::<Vec<_>>();
    serde_json::to_string(&json!({
        "schemaVersion": 2,
        "task": task,
        "intent": intent,
        "targets": resolutions,
        "changeContext": change_context_value(&change_input, &considered_changes),
        "strategy": {
            "retrieval": "fts5-graph-git",
            "ranking": "deterministic-change-aware",
            "maxCandidates": limit,
        },
        "candidates": candidate_values,
        "omittedCandidates": omitted_candidates,
        "uncertainties": uncertainties,
    }))
    .map_err(|error| invalid_argument(format!("Cannot encode task context: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, score: i64, why: &str) -> Candidate {
        Candidate {
            id: id.to_string(),
            kind: "file".to_string(),
            title: id.to_string(),
            detail: String::new(),
            path: Some(id.to_string()),
            symbol: None,
            start_line: Some(1),
            end_line: Some(1),
            evidence_sha: Some("abc".to_string()),
            indexed_sha: Some("abc".to_string()),
            evidence_meaning: None,
            indexed_meaning: None,
            provenance: "test".to_string(),
            certainty: "deterministic".to_string(),
            freshness_override: None,
            score,
            reasons: reason(why),
            is_test: false,
            source_backed: true,
        }
    }

    #[test]
    fn merged_candidates_keep_the_best_score_and_all_reasons() {
        let mut candidates = CandidateSet::default();
        candidates.insert(candidate("file:a", 10, "lexical"));
        candidates.insert(candidate("file:a", 20, "explicit"));
        let (ranked, omitted) = candidates.ranked("understand", 10);
        assert_eq!(omitted, 0);
        assert_eq!(ranked[0].score, 50);
        assert_eq!(
            ranked[0].reasons.iter().cloned().collect::<Vec<_>>(),
            ["explicit".to_string(), "lexical".to_string()]
        );
    }

    #[test]
    fn ranking_rewards_independent_signals_and_penalizes_repeated_paths() {
        let mut candidates = CandidateSet::default();
        let mut corroborated = candidate("file:a-one", 100, "lexical");
        corroborated.path = Some("a".to_string());
        corroborated.reasons.insert("graph".to_string());
        candidates.insert(corroborated);

        let mut same_path = candidate("file:a-two", 110, "lexical");
        same_path.path = Some("a".to_string());
        candidates.insert(same_path);

        let mut different_path = candidate("file:b", 90, "lexical");
        different_path.path = Some("b".to_string());
        candidates.insert(different_path);

        let (ranked, omitted) = candidates.ranked("implement", 3);
        assert_eq!(omitted, 0);
        assert_eq!(
            ranked
                .iter()
                .map(|value| value.id.as_str())
                .collect::<Vec<_>>(),
            ["file:a-one", "file:b", "file:a-two"]
        );
        assert!(ranked[2]
            .reasons
            .contains("repeated-path diversity penalty"));
        assert!(ranked[2].score < ranked[1].score);
    }

    #[test]
    fn lexical_query_does_not_search_the_selected_intent_as_subject_matter() {
        assert_eq!(
            lexical_task_query("Review: submitCheckout inventory", "review"),
            "submitCheckout inventory"
        );
        assert_eq!(
            lexical_task_query("debug review routing", "debug"),
            "review routing"
        );
        assert_eq!(lexical_task_query("review", "review"), "");
        assert_eq!(
            lexical_task_query("review the current working tree change", "review"),
            ""
        );
    }

    #[test]
    fn input_bounds_and_intents_are_validated() {
        assert!(parse_inputs("", "[]", None).is_err());
        assert!(parse_inputs("work", "[]", Some("invent")).is_err());
        assert_eq!(
            parse_inputs(" work ", "[\"src/a.rs\",\"src/a.rs\"]", Some("DEBUG"))
                .expect("valid input"),
            (
                "work".to_string(),
                vec!["src/a.rs".to_string()],
                "debug".to_string()
            )
        );
    }

    #[test]
    fn long_or_invalid_change_paths_degrade_without_aborting_the_plan() {
        let long_path = format!("src/{}/file.ts", "nested/".repeat(90));
        let input = parse_change_input(Some(
            &json!({
                "state": "available",
                "source": "test",
                "changes": [
                    { "path": long_path, "status": "modified" },
                    { "path": "../outside.ts", "status": "modified" }
                ],
                "detectedPaths": 2,
                "truncated": false
            })
            .to_string(),
        ))
        .expect("change input remains usable");
        assert_eq!(input.changes.len(), 1);
        assert!(input.changes[0].path.len() > MAX_TARGET_BYTES);
        assert!(input.truncated);
        assert_eq!(input.detected_paths, 2);
    }

    #[test]
    fn stale_and_unverified_evidence_are_not_reported_as_current() {
        let mut value = candidate("file:a", 1, "test");
        assert_eq!(value.freshness(), "current");
        value.evidence_sha = Some("old".to_string());
        assert_eq!(value.freshness(), "stale");
        value.evidence_sha = None;
        assert_eq!(value.freshness(), "unverified");
    }
}
