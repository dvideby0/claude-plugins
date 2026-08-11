import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScipEvaluation } from "../providers/index.js";
import {
  loadNative,
  type NativeScipOccurrence,
  type NativeScipProjection,
} from "../scan/source.js";
import {
  FACT_SCHEMA_VERSION,
  type FactAnchor,
  type FactBatch,
  type FactEdge,
  type FactEdgeKind,
  type FactEntityRef,
  type FactEvidence,
  type FactGeneration,
  type FactNode,
  type FactProducer,
  type FreshnessState,
} from "./model.js";

export interface ScipFactOptions {
  workspaceId: string;
  /** The currently indexed repository generation; required to expose staleness. */
  currentSourceSignature: string;
}

export interface ScipProjectionFactOptions {
  workspaceId: string;
  producer: FactProducer;
  generation: FactGeneration;
  freshness: FreshnessState;
  ownership: { scope: "file" | "workspace" | "provider-run" | "artifact"; key: string };
  generatedAt: string;
}

function id(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function fileId(path: string): string {
  return id("file", path);
}

function symbolId(key: string): string {
  return id("symbol", "scip", key);
}

function positionEncoding(value: string): FactAnchor["positionEncoding"] {
  if (value === "utf-8" || value === "utf-16" || value === "utf-32") return value;
  return "unknown";
}

function occurrenceAnchor(
  occurrence: NativeScipOccurrence,
  symbol?: string,
): FactAnchor {
  return {
    path: occurrence.path,
    ...(symbol ? { symbol } : {}),
    ...(occurrence.range
      ? {
          range: occurrence.range,
          positionEncoding: positionEncoding(occurrence.positionEncoding),
        }
      : {}),
  };
}

function occurrenceEvidence(
  occurrence: NativeScipOccurrence,
  symbol?: string,
): FactEvidence {
  return {
    kind: "provider",
    anchor: occurrenceAnchor(occurrence, symbol),
    detail: `SCIP occurrence roles: ${occurrence.nativeKind}`,
  };
}

function factFreshness(
  evaluation: ScipEvaluation,
  currentSourceSignature: string,
): FreshnessState {
  if (evaluation.input?.sourceSignature !== currentSourceSignature) {
    return "stale";
  }
  // Repository sources are attested, but the compiler dependency/read closure
  // is not. No current SCIP evaluation is eligible for exact freshness yet.
  return "unverified";
}

function generation(evaluation: ScipEvaluation): FactGeneration {
  if (!evaluation.input) {
    throw new Error("SCIP facts require the provider input generation recorded by the run.");
  }
  return {
    sourceSignature: evaluation.input.sourceSignature,
    inputSignature: evaluation.input.inputSignature,
    runId: evaluation.runId,
  };
}

function edgeKind(kind: NativeScipOccurrence["kind"]): FactEdgeKind {
  if (kind === "definition") return "contain";
  return kind;
}

function requireProjection(
  evaluation: ScipEvaluation,
): Promise<NativeScipProjection> {
  if (evaluation.status === "failed" || !evaluation.indexPath || !evaluation.scip) {
    throw new Error("SCIP facts require a retained, successfully decoded provider index.");
  }
  const native = loadNative();
  if (!native?.projectScip) {
    throw new Error("The native SCIP fact projection runtime is unavailable.");
  }
  return native.projectScip(
    evaluation.indexPath,
    join(evaluation.artifactDir, "input"),
    evaluation.input?.pathAliases ?? [],
  );
}

async function readDurableManifest(
  evaluation: ScipEvaluation,
  workspaceId: string,
): Promise<ScipEvaluation> {
  let durable: ScipEvaluation;
  try {
    durable = JSON.parse(
      await readFile(join(evaluation.artifactDir, "manifest.json"), "utf-8"),
    ) as ScipEvaluation;
  } catch (cause) {
    throw new Error("The durable SCIP run manifest is missing or invalid.", { cause });
  }
  if (
    durable.workspaceId !== workspaceId ||
    evaluation.workspaceId !== workspaceId
  ) {
    throw new Error("The requested SCIP evaluation does not belong to this workspace.");
  }
  if (
    durable.runId !== evaluation.runId ||
    durable.provider !== evaluation.provider ||
    durable.providerVersion !== evaluation.providerVersion ||
    durable.artifactDir !== evaluation.artifactDir ||
    durable.indexPath !== evaluation.indexPath ||
    durable.input?.sourceSignature !== evaluation.input?.sourceSignature ||
    durable.input?.inputSignature !== evaluation.input?.inputSignature ||
    durable.input?.pathAliasSignature !== evaluation.input?.pathAliasSignature
  ) {
    throw new Error("The requested SCIP evaluation no longer matches its durable run manifest.");
  }
  if (durable.scip?.sha256 !== evaluation.scip?.sha256) {
    throw new Error("The requested SCIP evaluation no longer matches its durable output digest.");
  }
  if (!durable.indexPath || durable.indexPath !== join(durable.artifactDir, "index.scip")) {
    throw new Error("The durable SCIP run manifest has an invalid artifact location.");
  }
  return durable;
}

async function validateDurableInput(durable: ScipEvaluation): Promise<Set<string>> {
  const entries = durable.input?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("The durable SCIP run manifest has no attested input entries.");
  }
  const aliases = durable.input?.pathAliases;
  const aliasSignature = durable.input?.pathAliasSignature;
  if (!Array.isArray(aliases) || !aliasSignature) {
    throw new Error("The durable SCIP run manifest has no bound document path aliases.");
  }
  const native = loadNative();
  if (!native?.verifySnapshotManifest || !durable.input) {
    throw new Error("The native provider input-manifest verification runtime is unavailable.");
  }
  await native.verifySnapshotManifest({
    inputSignature: durable.input.inputSignature,
    files: durable.input.files,
    bytes: durable.input.bytes,
    entries,
    pathAliases: aliases,
    pathAliasSignature: aliasSignature,
  });
  const inputs = new Set(entries.map((entry) => entry.path));
  const unattestedAlias = aliases.find((alias) => !inputs.has(alias.path));
  if (unattestedAlias) {
    throw new Error(
      `SCIP path alias does not resolve to an attested provider input: ${unattestedAlias.path}`,
    );
  }
  return inputs;
}

function validateProjection(
  durable: ScipEvaluation,
  projection: NativeScipProjection,
  inputs: Set<string>,
): void {
  if (durable.scip?.sha256 !== projection.sha256) {
    throw new Error("The retained SCIP artifact no longer matches its durable output digest.");
  }
  if (durable.input?.pathAliasSignature !== projection.pathAliasSignature) {
    throw new Error("The SCIP projection no longer matches its bound document path aliases.");
  }
  const unattested = projection.documents.find((document) => !inputs.has(document.path));
  if (unattested) {
    throw new Error(
      `SCIP document was not present in the attested provider input manifest: ${unattested.path}`,
    );
  }
}

/**
 * Shape official SCIP semantics into the common evidence envelope. The index
 * remains an evaluation artifact until STORE-001 provides native persistence.
 */
export async function projectScipFacts(
  evaluation: ScipEvaluation,
  options: ScipFactOptions,
): Promise<FactBatch> {
  if (!options.currentSourceSignature) {
    throw new Error("SCIP facts require the current indexed source generation.");
  }
  const durable = await readDurableManifest(evaluation, options.workspaceId);
  const inputs = await validateDurableInput(durable);
  const projection = await requireProjection(durable);
  validateProjection(durable, projection, inputs);

  return scipProjectionFacts(projection, {
    workspaceId: durable.workspaceId,
    producer: {
      id: durable.provider,
      version: durable.providerVersion,
      kind: "compiler",
    },
    generation: generation(durable),
    freshness: factFreshness(durable, options.currentSourceSignature),
    ownership: { scope: "provider-run", key: durable.runId },
    generatedAt: durable.finishedAt,
  });
}

/**
 * Translate an already validated official SCIP projection into the common
 * evidence envelope. Provider runners remain responsible for provenance,
 * input fencing, artifact bounds, and freshness before calling this boundary.
 */
export function scipProjectionFacts(
  projection: NativeScipProjection,
  options: ScipProjectionFactOptions,
): FactBatch {
  const {
    workspaceId,
    producer,
    generation: factGeneration,
    freshness,
    ownership,
    generatedAt,
  } = options;
  const definitions = new Map<string, NativeScipOccurrence[]>();
  for (const occurrence of projection.occurrences) {
    if (occurrence.kind !== "definition") continue;
    const current = definitions.get(occurrence.symbolKey) ?? [];
    current.push(occurrence);
    definitions.set(occurrence.symbolKey, current);
  }

  const symbols = new Map(projection.symbols.map((symbol) => [symbol.key, symbol]));
  const symbolRefs = new Map<string, FactEntityRef>();
  for (const symbol of projection.symbols) {
    const definition = definitions.get(symbol.key)?.find((item) => item.range)
      ?? definitions.get(symbol.key)?.[0];
    const anchor = definition
      ? occurrenceAnchor(definition, symbol.displayName)
      : symbol.path
        ? { path: symbol.path, symbol: symbol.displayName }
        : undefined;
    symbolRefs.set(symbol.key, {
      id: symbolId(symbol.key),
      nativeId: symbol.symbol,
      ...(anchor?.path ? { path: anchor.path } : {}),
      symbol: symbol.displayName,
      ...(symbol.external ? { external: symbol.symbol } : {}),
    });
  }

  const nodes: FactNode[] = projection.documents.map((document) => {
    const anchor: FactAnchor = { path: document.path };
    return {
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "node",
      id: fileId(document.path),
      workspaceId,
      kind: "file",
      nativeKind: document.language,
      name: document.path,
      anchor,
      producer,
      generation: factGeneration,
      certainty: "exact",
      freshness,
      ownership,
      evidence: [{ kind: "provider", anchor, detail: "SCIP source document" }],
      createdAt: generatedAt,
    };
  });

  for (const symbol of projection.symbols) {
    const symbolDefinitions = definitions.get(symbol.key) ?? [];
    const primary = symbolDefinitions.find((item) => item.range) ?? symbolDefinitions[0];
    const anchor = primary
      ? occurrenceAnchor(primary, symbol.displayName)
      : symbol.path
        ? { path: symbol.path, symbol: symbol.displayName }
        : undefined;
    const evidence: FactEvidence[] = symbolDefinitions.length
      ? symbolDefinitions.map((item) => occurrenceEvidence(item, symbol.displayName))
      : [
          {
            kind: "provider",
            ...(anchor ? { anchor } : {}),
            unavailableReason: symbol.external
              ? "SCIP identifies this external symbol but does not own its source definition."
              : "SCIP symbol information did not include a definition occurrence.",
          },
        ];
    nodes.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "node",
      id: symbolId(symbol.key),
      workspaceId,
      kind: "symbol",
      nativeKind: symbol.kind,
      name: symbol.displayName,
      ...(anchor ? { anchor } : {}),
      producer,
      generation: factGeneration,
      certainty:
        symbol.ambiguous || symbolDefinitions.some((item) => item.ambiguous)
          ? "ambiguous"
          : "exact",
      freshness,
      ownership,
      evidence,
      createdAt: generatedAt,
    });
  }

  const edges: FactEdge[] = [];
  for (const occurrence of projection.occurrences) {
    const target = symbolRefs.get(occurrence.symbolKey);
    if (!target) {
      throw new Error(`SCIP occurrence references a missing projected symbol: ${occurrence.symbol}`);
    }
    const source: FactEntityRef = { id: fileId(occurrence.path), path: occurrence.path };
    const kind = edgeKind(occurrence.kind);
    edges.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "edge",
      id: id(
        "scip-edge",
        occurrence.path,
        JSON.stringify(occurrence.range ?? null),
        kind,
        occurrence.symbolKey,
        occurrence.positionEncoding,
        occurrence.nativeKind,
      ),
      workspaceId,
      kind,
      nativeKind: `scip-occurrence:${occurrence.nativeKind}`,
      source,
      target,
      producer,
      generation: factGeneration,
      certainty: occurrence.ambiguous ? "ambiguous" : "exact",
      freshness,
      confidence: occurrence.ambiguous ? "medium" : "definite",
      ownership,
      evidence: [occurrenceEvidence(occurrence, symbols.get(occurrence.symbolKey)?.displayName)],
      createdAt: generatedAt,
    });
  }

  const nodeAnchors = new Map(nodes.map((node) => [node.id, node.anchor]));
  for (const relationship of projection.relationships) {
    const source = symbolRefs.get(relationship.sourceKey);
    const target = symbolRefs.get(relationship.targetKey);
    if (!source || !target) {
      throw new Error(
        `SCIP relationship references a missing projected symbol: ${relationship.sourceSymbol} -> ${relationship.targetSymbol}`,
      );
    }
    const sourceName = symbols.get(relationship.sourceKey)?.displayName;
    const relationshipDefinition = relationship.path
      ? definitions
          .get(relationship.sourceKey)
          ?.find((item) => item.path === relationship.path && item.range)
        ?? definitions.get(relationship.sourceKey)?.find((item) => item.path === relationship.path)
      : undefined;
    const sourceAnchor = relationshipDefinition
      ? occurrenceAnchor(relationshipDefinition, sourceName)
      : relationship.path
        ? { path: relationship.path, ...(sourceName ? { symbol: sourceName } : {}) }
        : source.id
          ? nodeAnchors.get(source.id)
          : undefined;
    edges.push({
      schemaVersion: FACT_SCHEMA_VERSION,
      type: "edge",
      id: id(
        "scip-relationship",
        relationship.sourceKey,
        relationship.targetKey,
        relationship.kind,
        relationship.nativeKind,
        relationship.path ?? "",
      ),
      workspaceId,
      kind: relationship.kind,
      nativeKind: `scip-relationship:${relationship.nativeKind}`,
      source,
      target,
      producer,
      generation: factGeneration,
      certainty: relationship.ambiguous ? "ambiguous" : "exact",
      freshness,
      confidence: relationship.ambiguous ? "medium" : "definite",
      ownership,
      evidence: [
        sourceAnchor
          ? {
              kind: "provider",
              anchor: sourceAnchor,
              detail: `SCIP ${relationship.nativeKind} relationship`,
            }
          : {
              kind: "provider",
              detail: `SCIP ${relationship.nativeKind} relationship`,
              unavailableReason: "The relationship source has no definition anchor in this index.",
            },
      ],
      createdAt: generatedAt,
    });
  }

  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    workspaceId,
    generation: factGeneration,
    generatedAt,
    nodes,
    edges,
  };
}
