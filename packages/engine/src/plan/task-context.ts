/**
 * Thin source-packing boundary for the Rust-owned task-context planner.
 *
 * Retrieval, graph expansion, and ranking stay beside SQLite in scan-core.
 * This module does the one job that belongs at the Node boundary: safely read
 * the already-selected workspace ranges and fit the complete MCP payload to a
 * real UTF-8 byte budget.
 */

import { Buffer } from "node:buffer";
import type {
  Db,
  TaskContextCandidate,
  TaskContextPlan,
  TaskIntent,
  TaskTargetResolution,
} from "../db/db.js";
import {
  readWorkspaceSourceSlice,
  sourceFreshness,
  type SourceFreshness,
} from "../lib/workspace-path.js";

const DEFAULT_BUDGET_BYTES = 12_000;
const MIN_BUDGET_BYTES = 6_000;
const MAX_BUDGET_BYTES = 100_000;
const DEFAULT_CANDIDATE_LIMIT = 64;
const MAX_EXCERPT_BYTES = 6_000;
const COMPACT_EXCERPT_BYTES = 1_200;
const EVIDENCE_SLOT_BYTES = 2_000;

export interface TaskContextOptions {
  task?: string;
  targets?: readonly string[];
  intent?: TaskIntent;
  budgetBytes?: number;
}

export interface TaskEvidenceRef {
  id: string;
  kind: string;
  title: string;
  score: number;
  reasons: string[];
  provenance: TaskContextCandidate["provenance"];
  source?: {
    path: string;
    symbol: string | null;
    startLine: number;
    endLine: number;
    indexedSha: string | null;
    evidenceSha: string | null;
    currentSha: string | null;
    freshness: SourceFreshness;
    excerptIncluded: boolean;
    excerptTruncated: boolean;
    error?: string;
  };
}

export interface TaskContextBrief {
  schemaVersion: 2;
  task: string;
  intent: TaskIntent;
  targets: TaskTargetResolution[];
  strategy: TaskContextPlan["strategy"] & {
    sourcePacking: "rank-order-path-diverse-utf8-budget";
    evaluationStatus: "experimental";
  };
  /** Compact human-readable view of the selected source excerpts. */
  text: string;
  evidence: TaskEvidenceRef[];
  readFirst: string[];
  budget: {
    scope: "complete-pretty-json-response";
    requestedBytes: number;
    usedBytes: number;
    truncated: boolean;
  };
  omissions: {
    plannerCandidates: number;
    budgetCandidates: number;
    excerpts: number;
    unavailableSources: number;
  };
  uncertainties: string[];
  followUps: string[];
}

interface MaterializedEvidence {
  candidate: TaskContextCandidate;
  source?: TaskEvidenceRef["source"];
  excerpt?: string;
}

function excerptOmissions(items: readonly MaterializedEvidence[]): number {
  return items.filter((item) => item.source?.excerptTruncated).length;
}

function unavailableSources(items: readonly MaterializedEvidence[]): number {
  return items.filter((item) => item.source?.error).length;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let used = 0;
  let result = "";
  for (const character of value) {
    const bytes = utf8Bytes(character);
    if (used + bytes + 3 > maxBytes) break;
    result += character;
    used += bytes;
  }
  return `${result.trimEnd()}…`;
}

function requestedBudget(value?: number): number {
  const budget = value ?? DEFAULT_BUDGET_BYTES;
  if (!Number.isInteger(budget) || budget < MIN_BUDGET_BYTES || budget > MAX_BUDGET_BYTES) {
    throw new Error(
      `brief budgetBytes must be an integer from ${MIN_BUDGET_BYTES} to ${MAX_BUDGET_BYTES}.`,
    );
  }
  return budget;
}

function numberedSource(content: string, startLine: number): string {
  return content
    .split("\n")
    .map((line, index) => `${startLine + index}|${line}`)
    .join("\n");
}

function renderText(
  selected: readonly MaterializedEvidence[],
  uncertainties: readonly string[],
): string {
  const sections = ["# Selected source"];
  if (selected.length > 0) {
    selected.forEach((item, index) => {
      const { candidate, source, excerpt } = item;
      if (source) {
        sections.push(
          "",
          `## ${index + 1}. ${source.path}:${source.startLine}-${source.endLine}` +
            `${source.symbol ? `#${source.symbol}` : ""}`,
        );
      } else {
        sections.push("", `## ${index + 1}. ${candidate.title} [${candidate.kind}]`);
      }
      if (candidate.detail) sections.push(candidate.detail);
      if (excerpt && source) {
        sections.push("Source excerpt:", numberedSource(excerpt, source.startLine));
      } else if (source?.error) {
        sections.push(`Source excerpt unavailable: ${source.error}`);
      }
    });
  } else {
    sections.push("", "No selected source. See omissions and uncertainty.");
  }
  if (uncertainties.length > 0) {
    sections.push("", "## Uncertainty", ...uncertainties.map((item) => `- ${item}`));
  }
  return sections.join("\n");
}

function evidenceRef(item: MaterializedEvidence): TaskEvidenceRef {
  return {
    id: item.candidate.id,
    kind: item.candidate.kind,
    title: item.candidate.title,
    score: item.candidate.score,
    reasons: item.candidate.reasons,
    provenance: item.source
      ? { ...item.candidate.provenance, freshness: item.source.freshness }
      : item.candidate.provenance,
    ...(item.source
      ? {
          source: {
            ...item.source,
            excerptIncluded: item.excerpt !== undefined,
          },
        }
      : {}),
  };
}

function followUps(plan: TaskContextPlan, selected: readonly MaterializedEvidence[]): string[] {
  const result: string[] = [];
  if (plan.targets.some((target) => target.status === "ambiguous")) {
    result.push("Refine ambiguous targets to a full repository-relative path or unique symbol.");
  }
  if (plan.targets.some((target) => target.status === "not-found")) {
    result.push("Re-index the repository or correct targets that are absent from the current index.");
  }
  if (selected.some((item) => item.source?.freshness === "stale")) {
    result.push("Re-index before trusting stale source-backed evidence.");
  }
  if (plan.uncertainties.some((item) => item.includes("import-resolved"))) {
    result.push("Run resolve_types when precise method/type references affect the change.");
  }
  return [...new Set(result)];
}

function responseBytes(response: TaskContextBrief): number {
  return utf8Bytes(JSON.stringify(response, null, 2));
}

function buildResponse(
  plan: TaskContextPlan,
  selected: readonly MaterializedEvidence[],
  requestedBytes: number,
  excerptOmissions: number,
  unavailableSources: number,
): TaskContextBrief {
  const budgetCandidates = plan.candidates.length - selected.length;
  const readFirst = [
    ...new Set(
      selected
        .map((item) => item.source?.path)
        .filter((path): path is string => path !== undefined),
    ),
  ];
  const response: TaskContextBrief = {
    schemaVersion: 2,
    task: plan.task,
    intent: plan.intent,
    targets: plan.targets,
    strategy: {
      ...plan.strategy,
      sourcePacking: "rank-order-path-diverse-utf8-budget",
      evaluationStatus: "experimental",
    },
    text: renderText(selected, plan.uncertainties),
    evidence: selected.map(evidenceRef),
    readFirst,
    budget: {
      scope: "complete-pretty-json-response",
      requestedBytes,
      usedBytes: 0,
      truncated:
        plan.omittedCandidates > 0 || budgetCandidates > 0 || excerptOmissions > 0,
    },
    omissions: {
      plannerCandidates: plan.omittedCandidates,
      budgetCandidates,
      excerpts: excerptOmissions,
      unavailableSources,
    },
    uncertainties: plan.uncertainties,
    followUps: followUps(plan, selected),
  };
  // `usedBytes` affects its own serialized width. Iterating to a fixed point
  // avoids off-by-one reports when its decimal representation gains a digit.
  for (let pass = 0; pass < 16; pass += 1) {
    const actual = responseBytes(response);
    if (actual === response.budget.usedBytes) return response;
    response.budget.usedBytes = actual;
  }
  throw new Error("Cannot stabilize task-context byte accounting.");
}

async function materialize(
  projectRoot: string,
  candidate: TaskContextCandidate,
): Promise<MaterializedEvidence> {
  if (!candidate.sourceBacked || !candidate.path) return { candidate };
  const anchorStart = candidate.startLine ?? 1;
  const anchorEnd = Math.max(anchorStart, candidate.endLine ?? anchorStart + 24);
  const startLine = Math.max(1, anchorStart - 3);
  const endLine = Math.min(anchorEnd + 6, startLine + 47);
  try {
    const slice = await readWorkspaceSourceSlice(projectRoot, candidate.path, startLine, endLine);
    const sourceRevisionFreshness = candidate.indexedSha
      ? sourceFreshness(slice.contentSha, candidate.indexedSha, candidate.evidenceSha)
      : "unverified";
    // The native planner can know that a provider generation is stale even
    // when the caller file itself has not changed. Preserve that stronger
    // warning while still checking the live working-tree revision here.
    const plannedFreshness = candidate.provenance.freshness;
    const freshness: SourceFreshness =
      plannedFreshness === "stale" || sourceRevisionFreshness === "stale"
        ? "stale"
        : plannedFreshness === "unverified" || sourceRevisionFreshness === "unverified"
          ? "unverified"
          : "current";
    return {
      candidate,
      source: {
        path: slice.path,
        symbol: candidate.symbol,
        startLine: slice.startLine,
        endLine: slice.endLine,
        indexedSha: candidate.indexedSha,
        evidenceSha: candidate.evidenceSha,
        currentSha: slice.contentSha,
        freshness,
        excerptIncluded: true,
        excerptTruncated: utf8Bytes(slice.content) > MAX_EXCERPT_BYTES,
      },
      excerpt: truncateUtf8(slice.content, MAX_EXCERPT_BYTES),
    };
  } catch (error) {
    return {
      candidate,
      source: {
        path: candidate.path,
        symbol: candidate.symbol,
        startLine,
        endLine,
        indexedSha: candidate.indexedSha,
        evidenceSha: candidate.evidenceSha,
        currentSha: null,
        freshness: "unverified",
        excerptIncluded: false,
        excerptTruncated: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Build one task-first briefing without adding another MCP tool. */
export async function buildTaskContext(
  db: Db,
  projectRoot: string,
  options: TaskContextOptions,
): Promise<TaskContextBrief> {
  const task = options.task?.trim() ?? "";
  const targets = (options.targets ?? []).map((target) => target.trim()).filter(Boolean);
  if (!task && targets.length === 0) {
    throw new Error("brief requires a task, at least one target, or both.");
  }
  const budget = requestedBudget(options.budgetBytes);
  const plan = db.taskContext(task, targets, options.intent ?? "understand", DEFAULT_CANDIDATE_LIMIT);
  // A byte ceiling is an upper bound, not a target to fill with metadata-only
  // tail facts. Reserve enough response space per admitted fact for its
  // structured navigation data and a useful compact excerpt.
  const evidenceLimit = Math.min(
    DEFAULT_CANDIDATE_LIMIT,
    Math.max(1, Math.floor(budget / EVIDENCE_SLOT_BYTES)),
  );
  const selected: MaterializedEvidence[] = [];
  const fullById = new Map<string, MaterializedEvidence>();
  const excerptedPaths = new Set<string>();

  const base = buildResponse(plan, selected, budget, 0, 0);
  if (responseBytes(base) > budget) {
    throw new Error(
      `The task and target metadata require ${responseBytes(base)} bytes; increase brief budgetBytes.`,
    );
  }

  for (const candidate of plan.candidates) {
    if (selected.length >= evidenceLimit) break;
    const full = await materialize(projectRoot, candidate);
    fullById.set(candidate.id, full);
    const compact =
      full.excerpt && utf8Bytes(full.excerpt) > COMPACT_EXCERPT_BYTES
        ? {
            ...full,
            source: full.source ? { ...full.source, excerptTruncated: true } : undefined,
            excerpt: truncateUtf8(full.excerpt, COMPACT_EXCERPT_BYTES),
          }
        : null;
    const withoutExcerpt = full.excerpt
      ? {
          ...full,
          source: full.source ? { ...full.source, excerptTruncated: true } : undefined,
          excerpt: undefined,
        }
      : null;
    // A run of high-ranked facts from one file should not spend the complete
    // response budget repeating overlapping source. Keep every fact in rank
    // order, but prefer metadata-only evidence after that path already has an
    // excerpt. This leaves room for the next dependency, caller, test, or
    // authored note to enter the same briefing.
    const repeatsExcerptedPath = full.source
      ? excerptedPaths.has(full.source.path)
      : false;
    const variants: MaterializedEvidence[] = repeatsExcerptedPath
      ? [withoutExcerpt, full, compact].filter(
          (variant): variant is MaterializedEvidence => variant !== null,
        )
      : [full, compact, withoutExcerpt].filter(
          (variant): variant is MaterializedEvidence => variant !== null,
        );

    let accepted: MaterializedEvidence | undefined;
    for (const variant of variants) {
      const trialItems = [...selected, variant];
      const trial = buildResponse(
        plan,
        trialItems,
        budget,
        excerptOmissions(trialItems),
        unavailableSources(trialItems),
      );
      if (responseBytes(trial) <= budget) {
        accepted = variant;
        break;
      }
    }
    if (!accepted) continue;
    selected.push(accepted);
    if (accepted.excerpt && accepted.source) excerptedPaths.add(accepted.source.path);
  }

  // The diversity pass deliberately prefers one excerpt per path. Restore
  // repeated-path excerpts only when every planner candidate was admitted;
  // otherwise free space is intentional headroom, not an invitation to repeat
  // source while ranked facts remain omitted.
  if (selected.length === plan.candidates.length) {
    for (let index = 0; index < selected.length; index += 1) {
      const current = selected[index]!;
      if (current.excerpt || current.source?.error) continue;
      const full = fullById.get(current.candidate.id);
      if (!full?.excerpt) continue;
      const compact =
        utf8Bytes(full.excerpt) > COMPACT_EXCERPT_BYTES
          ? {
              ...full,
              source: full.source ? { ...full.source, excerptTruncated: true } : undefined,
              excerpt: truncateUtf8(full.excerpt, COMPACT_EXCERPT_BYTES),
            }
          : null;
      for (const variant of [full, compact].filter(
        (item): item is MaterializedEvidence => item !== null,
      )) {
        const trialItems = selected.with(index, variant);
        const trial = buildResponse(
          plan,
          trialItems,
          budget,
          excerptOmissions(trialItems),
          unavailableSources(trialItems),
        );
        if (responseBytes(trial) <= budget) {
          selected[index] = variant;
          break;
        }
      }
    }
  }

  return buildResponse(
    plan,
    selected,
    budget,
    excerptOmissions(selected),
    unavailableSources(selected),
  );
}
