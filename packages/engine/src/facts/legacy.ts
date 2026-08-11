import { createHash } from "node:crypto";
import type { Db } from "../db/db.js";
import { TYPED_SPECIFIER, typedWorkspaceGeneration } from "../graph/typed-contract.js";
import { EXTRACTION_VERSION } from "../scan/scan.js";
import { indexedSourceSignature } from "../scan/signature.js";
import {
  FACT_SCHEMA_VERSION,
  type FactAnchor,
  type FactBatch,
  type FactEdge,
  type FactEdgeKind,
  type FactEntityRef,
  type FreshnessState,
  type FactGeneration,
  type FactNode,
  type FactProducer,
} from "./model.js";

export interface LegacyFactOptions {
  workspaceId: string;
  generatedAt?: string;
}

const PARSED_PRODUCER: FactProducer = {
  id: "sdlc-tree-sitter",
  version: String(EXTRACTION_VERSION),
  kind: "parsed",
};
const COMPILER_PRODUCER: FactProducer = {
  id: "sdlc-typescript-checker-prototype",
  version: "1",
  kind: "compiler",
};

function id(prefix: string, ...parts: Array<string | number | null>): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function fileId(path: string): string {
  return id("file", path);
}

function symbolId(nativeId: string): string {
  return id("symbol", nativeId);
}

function typedDeclarationNativeId(
  path: string,
  line: number,
  column: number,
  name: string,
): string {
  return `typescript:${path}:${line}:${column}:${name}`;
}

function zeroBased(line: number): number {
  return Math.max(0, line - 1);
}

function assertionKind(kind: string): FactEdgeKind {
  const kinds: Record<string, FactEdgeKind> = {
    calls: "call",
    registers: "register",
    handles: "handle",
    implements: "implement",
    configures: "configure",
    emits: "emit",
    reads: "read",
  };
  return kinds[kind] ?? "reference";
}

function compilerFreshness(
  recordedGeneration: string | null,
  recordedSourceSignature: string | null,
  currentGeneration: string,
): FreshnessState {
  if (!recordedGeneration || !recordedSourceSignature) return "unverified";
  // The prototype tracks repository sources/configs but not TypeScript's full
  // dependency, package-config, standard-library, or out-of-tree input closure.
  // A matching repository generation is therefore useful but not attested.
  return recordedGeneration === currentGeneration ? "unverified" : "stale";
}

interface LegacyReferenceRow {
  src_path: string;
  src_line: number;
  src_column: number;
  src_end_column: number | null;
  src_symbol: string | null;
  src_symbol_id: string | null;
  name: string;
  specifier: string;
  dst_path: string | null;
  dst_line: number | null;
  dst_column: number | null;
  dst_end_line: number | null;
  dst_end_column: number | null;
  dst_symbol_id: string | null;
  ref_generation: string | null;
  ref_source_signature: string | null;
}

function isTypedReference(reference: LegacyReferenceRow): boolean {
  return (
    reference.specifier === TYPED_SPECIFIER ||
    reference.specifier.startsWith(`${TYPED_SPECIFIER}:`)
  );
}

function compilerGeneration(reference: LegacyReferenceRow): FactGeneration {
  return { sourceSignature: reference.ref_source_signature };
}

function sourceRef(
  db: Db,
  path: string,
  nativeSymbolId?: string | null,
  symbol?: string | null,
): FactEntityRef {
  if (nativeSymbolId) {
    return { id: symbolId(nativeSymbolId), nativeId: nativeSymbolId, path, ...(symbol ? { symbol } : {}) };
  }
  if (symbol) {
    const matches = db.all<{ id: string }>(
      "SELECT id FROM symbols WHERE path = ? AND name = ? ORDER BY id LIMIT 2",
      [path, symbol],
    );
    if (matches.length === 1) {
      return { id: symbolId(matches[0]!.id), nativeId: matches[0]!.id, path, symbol };
    }
    return {
      path,
      symbol,
      unresolvedReason:
        matches.length > 1
          ? "More than one legacy symbol has this path and name."
          : "No indexed legacy symbol has this path and name.",
    };
  }
  return { id: fileId(path), path };
}

/**
 * Project the prototype tables into the neutral contract without rewriting or
 * promoting them. This gives provider adapters a concrete compatibility target
 * while the current storage remains authoritative.
 */
export function projectLegacyFacts(db: Db, options: LegacyFactOptions): FactBatch {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generation: FactGeneration = { sourceSignature: indexedSourceSignature(db) };
  const currentTypedGeneration = typedWorkspaceGeneration(db);
  const nodes: FactNode[] = [];
  const edges: FactEdge[] = [];

  for (const file of db.all<{ path: string; lang: string }>(
    "SELECT path, lang FROM files WHERE present = 1 ORDER BY path",
  )) {
    const anchor: FactAnchor = { path: file.path };
    nodes.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "node",
      id: fileId(file.path),
      workspaceId: options.workspaceId,
      kind: "file",
      nativeKind: file.lang,
      name: file.path,
      anchor,
      producer: PARSED_PRODUCER,
      generation,
      certainty: "exact",
      freshness: "current",
      ownership: { scope: "file", key: file.path },
      evidence: [{ kind: "source", anchor }],
      createdAt: generatedAt,
    });
  }

  const legacySymbols = db.all<{
    id: string;
    path: string;
    kind: string;
    name: string;
    start_line: number;
    start_column: number;
    end_line: number;
    end_column: number;
  }>(
    `SELECT id, path, kind, name, start_line, start_column, end_line, end_column
       FROM symbols ORDER BY path, start_line, start_column, id`,
  );
  const legacySymbolNames = new Map(legacySymbols.map((symbol) => [symbol.id, symbol.name]));
  for (const symbol of legacySymbols) {
    const anchor: FactAnchor = {
      path: symbol.path,
      symbol: symbol.name,
      positionEncoding: "utf-8",
      range: {
        startLine: zeroBased(symbol.start_line),
        startColumn: symbol.start_column,
        endLine: zeroBased(symbol.end_line),
        endColumn: symbol.end_column,
      },
    };
    nodes.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "node",
      id: symbolId(symbol.id),
      workspaceId: options.workspaceId,
      kind: "symbol",
      nativeKind: symbol.kind,
      name: symbol.name,
      anchor,
      producer: PARSED_PRODUCER,
      generation,
      certainty: "exact",
      freshness: "current",
      ownership: { scope: "file", key: symbol.path },
      evidence: [{ kind: "source", anchor }],
      createdAt: generatedAt,
    });
  }

  for (const edge of db.all<{
    src_path: string;
    specifier: string;
    dst_path: string | null;
    external: string | null;
  }>("SELECT src_path, specifier, dst_path, external FROM edges ORDER BY src_path, specifier")) {
    const target: FactEntityRef = edge.dst_path
      ? { id: fileId(edge.dst_path), path: edge.dst_path }
      : edge.external
        ? { external: edge.external, nativeId: edge.specifier }
        : {
            nativeId: edge.specifier,
            unresolvedReason: "The legacy import resolver could not identify a local or external target.",
          };
    edges.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "edge",
      id: id("import", edge.src_path, edge.specifier),
      workspaceId: options.workspaceId,
      kind: "import",
      source: { id: fileId(edge.src_path), path: edge.src_path },
      target,
      producer: PARSED_PRODUCER,
      generation,
      certainty: edge.dst_path || edge.external ? "exact" : "unknown",
      freshness: "current",
      ownership: { scope: "file", key: edge.src_path },
      evidence: [
        {
          kind: "source",
          unavailableReason:
            "The legacy import table records the source file but not the import's source range.",
        },
      ],
      createdAt: generatedAt,
    });
  }

  const references = db.all<LegacyReferenceRow>(
    `SELECT src_path, src_line, src_column, src_end_column, src_symbol, src_symbol_id, name, specifier,
            dst_path, dst_line, dst_column, dst_end_line, dst_end_column, dst_symbol_id,
            f.ref_generation, f.ref_source_signature
       FROM refs r
       LEFT JOIN files f ON f.path = r.src_path AND f.present = 1
       ORDER BY src_path, src_line, src_column, name`,
  );

  // A compiler-only declaration can be referenced by rows from several typed
  // generations. Resolve its fact once from the complete group so source-path
  // ordering cannot make a current declaration stale (or vice versa).
  const syntheticDeclarations = new Map<
    string,
    {
      nativeId: string;
      path: string;
      name: string;
      line: number;
      column: number;
      candidates: Array<{
        freshness: FreshnessState;
        generation: FactGeneration;
        matchesCurrentGeneration: boolean;
        endLine: number | null;
        endColumn: number | null;
      }>;
    }
  >();
  for (const reference of references) {
    if (
      !isTypedReference(reference) ||
      reference.dst_symbol_id ||
      !reference.dst_path ||
      reference.dst_line === null ||
      reference.dst_column === null
    ) {
      continue;
    }
    const nativeId = typedDeclarationNativeId(
      reference.dst_path,
      reference.dst_line,
      reference.dst_column,
      reference.name,
    );
    const nodeId = symbolId(nativeId);
    const candidate = {
      freshness: compilerFreshness(
        reference.ref_generation,
        reference.ref_source_signature,
        currentTypedGeneration,
      ),
      generation: compilerGeneration(reference),
      matchesCurrentGeneration:
        reference.ref_generation !== null &&
        reference.ref_source_signature !== null &&
        reference.ref_generation === currentTypedGeneration,
      endLine: reference.dst_end_line,
      endColumn: reference.dst_end_column,
    };
    const existing = syntheticDeclarations.get(nodeId);
    if (existing) {
      existing.candidates.push(candidate);
    } else {
      syntheticDeclarations.set(nodeId, {
        nativeId,
        path: reference.dst_path,
        name: reference.name,
        line: reference.dst_line,
        column: reference.dst_column,
        candidates: [candidate],
      });
    }
  }

  for (const [nodeId, declaration] of [...syntheticDeclarations].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const current = declaration.candidates.find(
      (candidate) => candidate.matchesCurrentGeneration,
    );
    const attested = declaration.candidates.filter(
      (candidate) => candidate.generation.sourceSignature !== null,
    );
    const attestedGenerations = new Set(
      attested.map(
        (candidate) =>
          `${candidate.generation.sourceSignature}\0${candidate.generation.inputSignature ?? ""}`,
      ),
    );
    const selected = current ?? (attestedGenerations.size === 1 ? attested[0] : undefined);
    const freshness: FreshnessState = current
      ? "unverified"
      : selected && declaration.candidates.every((candidate) => candidate.freshness === "stale")
        ? "stale"
        : "unverified";
    const selectedRange =
      selected?.endLine !== null &&
      selected?.endLine !== undefined &&
      selected.endColumn !== null &&
      selected.endColumn !== undefined
        ? { endLine: selected.endLine, endColumn: selected.endColumn }
        : null;
    const declarationAnchor: FactAnchor = {
      path: declaration.path,
      symbol: declaration.name,
      ...(selectedRange
        ? {
            positionEncoding: "utf-8" as const,
            range: {
              startLine: zeroBased(declaration.line),
              startColumn: declaration.column,
              endLine: zeroBased(selectedRange.endLine),
              endColumn: selectedRange.endColumn,
            },
          }
        : {}),
    };
    nodes.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "node",
      id: nodeId,
      workspaceId: options.workspaceId,
      kind: "symbol",
      nativeKind: "local-declaration",
      name: declaration.name,
      anchor: declarationAnchor,
      producer: COMPILER_PRODUCER,
      generation: selected?.generation ?? { sourceSignature: null },
      certainty: "exact",
      freshness,
      ownership: { scope: "file", key: declaration.path },
      evidence: [
        declarationAnchor.range
          ? { kind: "source", anchor: declarationAnchor }
          : {
              kind: "source",
              anchor: declarationAnchor,
              unavailableReason:
                "The legacy compiler row did not preserve the declaration token end.",
            },
      ],
      createdAt: generatedAt,
    });
  }

  for (const reference of references) {
    const typed = isTypedReference(reference);
    const typedFreshness = compilerFreshness(
      reference.ref_generation,
      reference.ref_source_signature,
      currentTypedGeneration,
    );
    const sourceRange =
      reference.src_end_column !== null
        ? {
            startLine: zeroBased(reference.src_line),
            startColumn: reference.src_column,
            endLine: zeroBased(reference.src_line),
            endColumn: reference.src_end_column,
          }
        : null;
    const anchor: FactAnchor = {
      path: reference.src_path,
      ...(reference.src_symbol ? { symbol: reference.src_symbol } : {}),
      ...(sourceRange ? { positionEncoding: "utf-8" as const, range: sourceRange } : {}),
    };
    const typedDeclarationId =
      typed &&
      reference.dst_path &&
      reference.dst_line !== null &&
      reference.dst_column !== null
        ? typedDeclarationNativeId(
            reference.dst_path,
            reference.dst_line,
            reference.dst_column,
            reference.name,
          )
        : null;
    const target: FactEntityRef = reference.dst_symbol_id
      ? {
          id: symbolId(reference.dst_symbol_id),
          nativeId: reference.dst_symbol_id,
          ...(reference.dst_path ? { path: reference.dst_path } : {}),
          symbol: legacySymbolNames.get(reference.dst_symbol_id) ?? reference.name,
        }
      : typedDeclarationId && reference.dst_path
        ? {
            id: symbolId(typedDeclarationId),
            nativeId: typedDeclarationId,
            path: reference.dst_path,
            symbol: reference.name,
          }
        : reference.dst_path
          ? { id: fileId(reference.dst_path), path: reference.dst_path, symbol: reference.name }
          : {
              nativeId: reference.specifier,
              symbol: reference.name,
              unresolvedReason: "The legacy reference did not resolve to an indexed declaration.",
            };
    edges.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "edge",
      id: id(
        "reference",
        reference.src_path,
        reference.src_line,
        reference.src_column,
        reference.name,
        reference.specifier,
      ),
      workspaceId: options.workspaceId,
      kind: "reference",
      source: sourceRef(db, reference.src_path, reference.src_symbol_id, reference.src_symbol),
      target,
      producer: typed ? COMPILER_PRODUCER : PARSED_PRODUCER,
      generation: typed ? compilerGeneration(reference) : generation,
      certainty: reference.dst_path ? (typed ? "exact" : "inferred") : "unknown",
      freshness: typed ? typedFreshness : "current",
      ownership: { scope: "file", key: reference.src_path },
      evidence: [{ kind: "source", anchor }],
      createdAt: generatedAt,
    });
  }

  for (const relation of db.all<{
    id: string;
    kind: string;
    src_path: string;
    src_symbol: string | null;
    dst_path: string | null;
    dst_symbol: string | null;
    label: string | null;
    evidence: string;
    evidence_line: number | null;
    confidence: "definite" | "high" | "medium" | "low";
    source: string;
    content_sha: string | null;
    current_sha: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT r.*, f.content_sha AS current_sha
       FROM relations r
       LEFT JOIN files f ON f.path = r.src_path AND f.present = 1
       ORDER BY r.id`,
  )) {
    const anchor: FactAnchor = {
      path: relation.src_path,
      ...(relation.src_symbol ? { symbol: relation.src_symbol } : {}),
      ...(relation.evidence_line
        ? {
            positionEncoding: "unknown" as const,
            range: {
              startLine: zeroBased(relation.evidence_line),
              startColumn: 0,
              endLine: zeroBased(relation.evidence_line),
              endColumn: 0,
            },
          }
        : {}),
    };
    edges.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "edge",
      id: id("asserted", relation.id),
      workspaceId: options.workspaceId,
      kind: assertionKind(relation.kind),
      nativeKind: relation.kind,
      source: sourceRef(db, relation.src_path, null, relation.src_symbol),
      target: relation.dst_path
        ? sourceRef(db, relation.dst_path, null, relation.dst_symbol)
        : {
            ...(relation.dst_symbol ? { symbol: relation.dst_symbol } : {}),
            ...(relation.label ? { nativeId: relation.label } : {}),
            unresolvedReason: "The authored relation does not identify an indexed destination file.",
          },
      producer: {
        id: relation.source || "legacy-author",
        version: "1",
        kind: relation.source === "agent" ? "llm" : "human",
      },
      generation: { sourceSignature: null, runId: relation.updated_at },
      certainty: "asserted",
      freshness:
        relation.content_sha !== null && relation.content_sha !== relation.current_sha
          ? "stale"
          : "unverified",
      confidence: relation.confidence,
      ownership: { scope: "artifact", key: relation.id },
      evidence: [{ kind: "source", anchor, detail: relation.evidence }],
      createdAt: relation.created_at,
    });
  }

  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    workspaceId: options.workspaceId,
    generation,
    generatedAt,
    nodes,
    edges,
  };
}
