/** Versioned, provider-neutral boundary for code-intelligence facts. */
export const FACT_SCHEMA_VERSION = 1 as const;

export const PRODUCER_KINDS = [
  "parsed",
  "compiler",
  "framework",
  "runtime",
  "human",
  "llm",
] as const;
export type ProducerKind = (typeof PRODUCER_KINDS)[number];

export const CERTAINTY_CLASSES = [
  "exact",
  "inferred",
  "observed",
  "asserted",
  "ambiguous",
  "unknown",
] as const;
export type CertaintyClass = (typeof CERTAINTY_CLASSES)[number];

export const FRESHNESS_STATES = ["current", "stale", "unverified"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** Initial vocabulary; providers may preserve a more specific native kind as metadata. */
export const EDGE_KINDS = [
  "contain",
  "import",
  "reference",
  "call",
  "return",
  "branch",
  "throw",
  "catch",
  "await",
  "resume",
  "register",
  "dispatch",
  "read",
  "write",
  "emit",
  "handle",
  "implement",
  "configure",
  "terminal-effect",
] as const;
export type FactEdgeKind = (typeof EDGE_KINDS)[number];

export interface FactProducer {
  id: string;
  version: string;
  kind: ProducerKind;
}

export interface FactGeneration {
  /** Signature of the deterministic source inventory, null for unattested legacy facts. */
  sourceSignature: string | null;
  /** Exact provider input view when it differs from the source inventory. */
  inputSignature?: string;
  /** Provider run, runtime observation, or authored-artifact generation. */
  runId?: string;
}

/** Zero-based, half-open range. This matches SCIP/LSP-style provider ranges. */
export interface FactRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface FactAnchor {
  path: string;
  range?: FactRange;
  positionEncoding?: "utf-8" | "utf-16" | "utf-32" | "unknown";
  symbol?: string;
}

export interface FactEvidence {
  kind: "source" | "provider" | "runtime" | "human";
  anchor?: FactAnchor;
  detail?: string;
  /** Required when the legacy/provider fact has no navigable source range. */
  unavailableReason?: string;
}

export interface FactEntityRef {
  /** Stable provider-neutral id when the endpoint is known. */
  id?: string;
  /** Preserved provider id for round-tripping and debugging. */
  nativeId?: string;
  path?: string;
  symbol?: string;
  external?: string;
  /** Why no stable endpoint could be resolved. */
  unresolvedReason?: string;
}

interface FactBase {
  schemaVersion: typeof FACT_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  producer: FactProducer;
  generation: FactGeneration;
  certainty: CertaintyClass;
  freshness: FreshnessState;
  /** Producer-owned replacement unit, such as a file or provider run. */
  ownership: { scope: "file" | "workspace" | "provider-run" | "artifact"; key: string };
  evidence: FactEvidence[];
  createdAt: string;
}

export interface FactNode extends FactBase {
  type: "node";
  kind: "file" | "symbol" | "effect" | "unknown";
  nativeKind?: string;
  name: string;
  anchor?: FactAnchor;
}

export interface FactEdge extends FactBase {
  type: "edge";
  kind: FactEdgeKind;
  nativeKind?: string;
  source: FactEntityRef;
  target: FactEntityRef;
  confidence?: "definite" | "high" | "medium" | "low";
}

export interface FactBatch {
  schemaVersion: typeof FACT_SCHEMA_VERSION;
  workspaceId: string;
  generation: FactGeneration;
  generatedAt: string;
  nodes: FactNode[];
  edges: FactEdge[];
}

export function hasNavigableEvidence(evidence: FactEvidence): boolean {
  return Boolean(evidence.anchor || evidence.unavailableReason);
}
