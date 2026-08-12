export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CONFIDENCES = ["definite", "high", "medium", "low"] as const;
export const CATEGORIES = [
  "security",
  "correctness",
  "error_handling",
  "performance",
  "types",
  "testing",
  "maintainability",
  "dependencies",
  "documentation",
] as const;
export const SOURCES = ["linter", "typecheck", "secrets", "deps", "graph", "llm"] as const;
export const STATUSES = ["open", "fixed", "regressed", "accepted", "false_positive"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Source = (typeof SOURCES)[number];
export type Status = (typeof STATUSES)[number];

export interface FindingInput {
  ruleId: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  source: Source;
  title: string;
  description?: string;
  suggestion?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  /** Code at the finding site — used for fingerprinting and drift detection. */
  snippet?: string;
  /** Exact full-file revision from which this finding's range and snippet came. */
  evidenceSha?: string | null;
  /** Enclosing symbol name, when known. Makes fingerprints survive line moves. */
  symbol?: string;
}

export interface FindingRow {
  id: string;
  rule_id: string;
  category: string;
  severity: string;
  confidence: string;
  source: string;
  path: string | null;
  line_start: number | null;
  line_end: number | null;
  title: string;
  description: string;
  suggestion: string | null;
  status: string;
  first_seen_run: number | null;
  last_seen_run: number | null;
  occurrences: number;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 2;
}

export function normalizeSeverity(value: string | undefined): Severity {
  const v = (value ?? "").toLowerCase();
  if (v === "critical" || v === "fatal" || v === "blocker") return "critical";
  if (v === "high" || v === "error" || v === "warning") return "high";
  if (v === "low" || v === "info" || v === "note" || v === "hint") return "low";
  return "medium";
}
