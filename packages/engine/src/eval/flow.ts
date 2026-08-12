import type { CertaintyClass, FactEdgeKind, FactProducer } from "../facts/model.js";
import {
  metricThresholdFailures,
  scoreMetric,
  type EntryToEffectOracle,
  type ExpectedFlowEntrypoint,
  type ExpectedFlowPath,
  type ExpectedFlowRelation,
  type FlowEntity,
  type FlowThreshold,
  type MetricScore,
} from "./model.js";

export interface CandidateFlowEntrypoint extends ExpectedFlowEntrypoint {
  registrationRelation: string;
  producer: FactProducer;
}

export interface CandidateFlowRelation {
  id: string;
  kind: FactEdgeKind;
  source: FlowEntity;
  target: FlowEntity;
  certainty: CertaintyClass;
  evidence: ExpectedFlowRelation["evidence"];
  producer: FactProducer;
}

export interface CandidateFlowPath {
  id: string;
  entrypoint: string;
  relations: string[];
  terminalRelation: string;
  conditions: string[];
  certainty: CertaintyClass;
  producer: FactProducer;
}

export interface CandidateFlowGraph {
  entrypoints: CandidateFlowEntrypoint[];
  relations: CandidateFlowRelation[];
  paths: CandidateFlowPath[];
  diagnostics: string[];
}

export interface ComparableFlowPath {
  id: string;
  entrypoint: string;
  entrypointKey: string;
  relations: Array<Pick<ExpectedFlowRelation, "kind" | "source" | "target">>;
  missingRelationIds: string[];
  terminalRelation: Pick<ExpectedFlowRelation, "kind" | "source" | "target"> | null;
}

export interface FlowMetadataMismatch {
  relation: Pick<ExpectedFlowRelation, "id" | "kind" | "source" | "target">;
  expectedCertainty: CertaintyClass;
  actualCertainty: CertaintyClass;
  expectedEvidence: ExpectedFlowRelation["evidence"];
  actualEvidence: ExpectedFlowRelation["evidence"];
}

export interface FlowEntrypointMetadataMismatch {
  entrypoint: Pick<ExpectedFlowEntrypoint, "id" | "target">;
  expectedRegistration: ExpectedFlowEntrypoint["registration"];
  actualRegistration: ExpectedFlowEntrypoint["registration"];
}

export interface FlowPathMetadataMismatch {
  path: Pick<ExpectedFlowPath, "id" | "entrypoint">;
  expectedCertainty: CertaintyClass;
  actualCertainty: CertaintyClass;
}

export interface FlowScores {
  entrypoints: MetricScore<ExpectedFlowEntrypoint>;
  relations: MetricScore<ExpectedFlowRelation>;
  paths: MetricScore<ComparableFlowPath>;
  entrypointMetadataMismatches: FlowEntrypointMetadataMismatch[];
  metadataMismatches: FlowMetadataMismatch[];
  pathMetadataMismatches: FlowPathMetadataMismatch[];
  explicitlyUnmeasured: string[];
}

function relationEvidenceMatches(mismatch: FlowMetadataMismatch): boolean {
  return (
    mismatch.expectedEvidence.path === mismatch.actualEvidence.path &&
    mismatch.expectedEvidence.startLine === mismatch.actualEvidence.startLine
  );
}

export function flowAcceptanceFailures(
  scores: FlowScores,
  thresholds: FlowThreshold,
  diagnostics: string[],
): string[] {
  const relationEvidenceMismatches = scores.metadataMismatches.filter(
    (mismatch) => !relationEvidenceMatches(mismatch),
  );
  return [
    ...metricThresholdFailures("entrypoints", scores.entrypoints, thresholds.entrypoints),
    ...metricThresholdFailures("relations", scores.relations, thresholds.relations),
    ...metricThresholdFailures("paths", scores.paths, thresholds.paths),
    ...(scores.entrypointMetadataMismatches.length > 0
      ? [`${scores.entrypointMetadataMismatches.length} entrypoint evidence anchor(s) do not match the oracle.`]
      : []),
    ...(relationEvidenceMismatches.length > 0
      ? [`${relationEvidenceMismatches.length} relation evidence anchor(s) do not match the oracle.`]
      : []),
    ...diagnostics.map((diagnostic) => `Adapter diagnostic: ${diagnostic}`),
  ];
}

export function flowEntityKey(entity: FlowEntity): string {
  return "external" in entity
    ? `external:${entity.external}`
    : `source:${entity.path}:${entity.symbol ?? ""}`;
}

export function flowRelationKey(
  relation: Pick<ExpectedFlowRelation, "kind" | "source" | "target">,
): string {
  return `${relation.kind}\0${flowEntityKey(relation.source)}\0${flowEntityKey(relation.target)}`;
}

function entrypointKey(entrypoint: ExpectedFlowEntrypoint): string {
  return `${entrypoint.id}\0${flowEntityKey(entrypoint.target)}`;
}

function comparablePaths(
  entrypoints: ExpectedFlowEntrypoint[],
  relations: Array<ExpectedFlowRelation | CandidateFlowRelation>,
  paths: Array<ExpectedFlowPath | CandidateFlowPath>,
): ComparableFlowPath[] {
  const entrypointKeys = new Map(
    entrypoints.map((entrypoint) => [entrypoint.id, entrypointKey(entrypoint)]),
  );
  const relationById = new Map(relations.map((relation) => [relation.id, relation]));
  return paths.map((path) => ({
    id: path.id,
    entrypoint: path.entrypoint,
    entrypointKey: entrypointKeys.get(path.entrypoint) ?? `unknown:${path.entrypoint}`,
    relations: path.relations.flatMap((id) => {
      const relation = relationById.get(id);
      return relation
        ? [{ kind: relation.kind, source: relation.source, target: relation.target }]
        : [];
    }),
    missingRelationIds: path.relations.filter((id) => !relationById.has(id)),
    terminalRelation: (() => {
      const relation = relationById.get(path.terminalRelation);
      return relation
        ? { kind: relation.kind, source: relation.source, target: relation.target }
        : null;
    })(),
  }));
}

function pathKey(path: ComparableFlowPath): string {
  const relations = path.relations.map(flowRelationKey).join("\u001e");
  const missing = path.missingRelationIds.join("\u001e");
  const terminal = path.terminalRelation ? flowRelationKey(path.terminalRelation) : "missing";
  return `${path.entrypointKey}\0${relations}\0${missing}\0${terminal}`;
}

/**
 * Score the product-level flow graph without treating provider-native node ids
 * or oracle-authored relation ids as semantic identity.
 *
 * Certainty and evidence are reported separately: a framework inference can
 * find the right relationship without being silently promoted to exact truth.
 */
export function scoreFlowGraph(
  candidate: CandidateFlowGraph,
  oracle: EntryToEffectOracle,
): FlowScores {
  const candidateEntrypoints: ExpectedFlowEntrypoint[] = candidate.entrypoints.map(
    ({ id, registration, target }) => ({ id, registration, target }),
  );
  const candidateRelations: ExpectedFlowRelation[] = candidate.relations.map(
    ({ id, kind, source, target, certainty, evidence }) => ({
      id,
      kind,
      source,
      target,
      certainty,
      evidence,
    }),
  );
  const expectedPaths = comparablePaths(oracle.entrypoints, oracle.relations, oracle.paths);
  const actualPaths = comparablePaths(candidateEntrypoints, candidate.relations, candidate.paths);

  const expectedByEntrypoint = new Map(
    oracle.entrypoints.map((entrypoint) => [entrypointKey(entrypoint), entrypoint]),
  );
  const entrypointMetadataMismatches = candidateEntrypoints.flatMap((actual) => {
    const expected = expectedByEntrypoint.get(entrypointKey(actual));
    if (
      !expected ||
      (expected.registration.path === actual.registration.path &&
        expected.registration.startLine === actual.registration.startLine)
    ) {
      return [];
    }
    return [
      {
        entrypoint: { id: expected.id, target: expected.target },
        expectedRegistration: expected.registration,
        actualRegistration: actual.registration,
      },
    ];
  });

  const expectedByRelation = new Map(
    oracle.relations.map((relation) => [flowRelationKey(relation), relation]),
  );
  const metadataMismatches = candidate.relations.flatMap((actual) => {
    const expected = expectedByRelation.get(flowRelationKey(actual));
    if (
      !expected ||
      (expected.certainty === actual.certainty &&
        expected.evidence.path === actual.evidence.path &&
        expected.evidence.startLine === actual.evidence.startLine)
    ) {
      return [];
    }
    return [
      {
        relation: {
          id: expected.id,
          kind: expected.kind,
          source: expected.source,
          target: expected.target,
        },
        expectedCertainty: expected.certainty,
        actualCertainty: actual.certainty,
        expectedEvidence: expected.evidence,
        actualEvidence: actual.evidence,
      },
    ];
  });
  const expectedPathByKey = new Map(
    expectedPaths.map((path, index) => [pathKey(path), oracle.paths[index]!] as const),
  );
  const pathMetadataMismatches = actualPaths.flatMap((actualPath, index) => {
    const expected = expectedPathByKey.get(pathKey(actualPath));
    const actual = candidate.paths[index]!;
    if (!expected || expected.certainty === actual.certainty) return [];
    return [
      {
        path: { id: expected.id, entrypoint: expected.entrypoint },
        expectedCertainty: expected.certainty,
        actualCertainty: actual.certainty,
      },
    ];
  });

  return {
    entrypoints: scoreMetric(oracle.entrypoints, candidateEntrypoints, entrypointKey),
    relations: scoreMetric(oracle.relations, candidateRelations, flowRelationKey),
    paths: scoreMetric(expectedPaths, actualPaths, pathKey),
    entrypointMetadataMismatches,
    metadataMismatches,
    pathMetadataMismatches,
    explicitlyUnmeasured: [
      "branch-condition equivalence",
      "runtime path feasibility",
      "data-value propagation into terminal effects",
    ],
  };
}
