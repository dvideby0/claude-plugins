import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flowAcceptanceFailures, scoreFlowGraph } from "../eval/flow.js";
import {
  deriveLangGraphFlow,
  enumerateFlowPaths,
  parseJoernGraphson,
} from "../eval/joern-graphson.js";
import { loadEvaluationOracle } from "../eval/model.js";

interface Vertex {
  "@type": "g:Vertex";
  id: { "@type": "g:Int64"; "@value": number };
  label: string;
  properties: Record<string, unknown>;
}

interface Edge {
  "@type": "g:Edge";
  id: { "@type": "g:Int64"; "@value": number };
  outV: { "@type": "g:Int64"; "@value": number };
  inV: { "@type": "g:Int64"; "@value": number };
  label: string;
  properties: Record<string, never>;
}

function typed(value: number): { "@type": "g:Int64"; "@value": number } {
  return { "@type": "g:Int64", "@value": value };
}

function property(value: string | number): unknown {
  return {
    "@type": "g:VertexProperty",
    "@value": { "@type": "g:List", "@value": [value] },
  };
}

function fixtureGraphson(): string {
  let nextNode = 1;
  let nextEdge = 1;
  const vertices: Vertex[] = [];
  const edges: Edge[] = [];
  const vertex = (label: string, properties: Record<string, string | number>): number => {
    const id = nextNode++;
    vertices.push({
      "@type": "g:Vertex",
      id: typed(id),
      label,
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, value]) => [name, property(value)]),
      ),
    });
    return id;
  };
  const edge = (outV: number, inV: number, label: string): void => {
    edges.push({
      "@type": "g:Edge",
      id: typed(nextEdge++),
      outV: typed(outV),
      inV: typed(inV),
      label,
      properties: {},
    });
  };

  const method = (name: string, fullName: string, filename: string, line: number): number =>
    vertex("METHOD", { NAME: name, FULL_NAME: fullName, FILENAME: filename, LINE_NUMBER: line });
  const methods = {
    build: method("build", "arena/graph.py:<module>.build", "arena/graph.py", 15),
    classify: method("classify", "arena/nodes.py:<module>.classify", "arena/nodes.py", 6),
    classifyRoute: method(
      "route_after_classify",
      "arena/nodes.py:<module>.route_after_classify",
      "arena/nodes.py",
      11,
    ),
    research: method("research", "arena/nodes.py:<module>.research", "arena/nodes.py", 15),
    consolidate: method(
      "consolidate",
      "arena/nodes.py:<module>.consolidate",
      "arena/nodes.py",
      19,
    ),
    consolidateRoute: method(
      "route_after_consolidate",
      "arena/nodes.py:<module>.route_after_consolidate",
      "arena/nodes.py",
      23,
    ),
    finalize: method("finalize", "arena/nodes.py:<module>.finalize", "arena/nodes.py", 27),
    search: method("search_web", "arena/effects.py:<module>.search_web", "arena/effects.py", 4),
    persist: method(
      "persist_result",
      "arena/effects.py:<module>.persist_result",
      "arena/effects.py",
      9,
    ),
  };

  const argument = (call: number, index: number, code: string, label = "IDENTIFIER"): number => {
    const id = vertex(label, { ARGUMENT_INDEX: index, CODE: code });
    edge(call, id, "ARGUMENT");
    return id;
  };
  const call = (
    owner: number,
    name: string,
    fullName: string,
    line: number,
    arguments_: Array<[number, string, string?]>,
  ): number => {
    const id = vertex("CALL", {
      NAME: name,
      METHOD_FULL_NAME: fullName,
      CODE: name,
      LINE_NUMBER: line,
    });
    edge(owner, id, "AST");
    for (const [index, code, label] of arguments_) argument(id, index, code, label);
    return id;
  };
  const stateCall = (
    name: "add_node" | "add_edge" | "add_conditional_edges",
    line: number,
    arguments_: Array<[number, string, string?]>,
  ): number =>
    call(
      methods.build,
      name,
      `langgraph/graph.py:<module>.StateGraph.${name}`,
      line,
      [[0, "builder"], ...arguments_],
    );
  const callArgumentByLabel = (callId: number, label: string): number => {
    const selected = edges.find(
      (candidate) =>
        candidate.label === "ARGUMENT" &&
        candidate.outV["@value"] === callId &&
        vertices.find((candidateVertex) => candidateVertex.id["@value"] === candidate.inV["@value"])
          ?.label === label,
    );
    if (!selected) throw new Error(`No ${label} argument found for synthetic call ${callId}.`);
    return selected.inV["@value"];
  };

  stateCall("add_node", 18, [
    [1, '"classify"', "LITERAL"],
    [2, "classify"],
  ]);
  stateCall("add_node", 19, [
    [1, '"research"', "LITERAL"],
    [2, "research"],
  ]);
  stateCall("add_node", 20, [
    [1, '"consolidate"', "LITERAL"],
    [2, "consolidate"],
  ]);
  stateCall("add_node", 21, [
    [1, '"finalize"', "LITERAL"],
    [2, "finalize"],
  ]);
  stateCall("add_edge", 22, [
    [1, "START"],
    [2, '"classify"', "LITERAL"],
  ]);

  const classifyConditional = stateCall("add_conditional_edges", 23, [
    [1, '"classify"', "LITERAL"],
    [2, "route_after_classify"],
    [3, '["research", END]', "CALL"],
  ]);
  const classifyTargets = callArgumentByLabel(classifyConditional, "CALL");
  argument(classifyTargets, 1, '"research"', "LITERAL");
  argument(classifyTargets, 2, "END");

  stateCall("add_edge", 24, [
    [1, '"research"', "LITERAL"],
    [2, '"consolidate"', "LITERAL"],
  ]);
  const consolidateConditional = stateCall("add_conditional_edges", 25, [
    [1, '"consolidate"', "LITERAL"],
    [2, "route_after_consolidate"],
    [3, '["finalize", END]', "CALL"],
  ]);
  const consolidateTargets = callArgumentByLabel(consolidateConditional, "CALL");
  argument(consolidateTargets, 1, '"finalize"', "LITERAL");
  argument(consolidateTargets, 2, "END");
  stateCall("add_edge", 28, [
    [1, '"finalize"', "LITERAL"],
    [2, "END"],
  ]);

  call(methods.research, "search_web", "arena/effects.py:<module>.search_web", 16, [[1, "subject"]]);
  call(methods.finalize, "persist_result", "arena/effects.py:<module>.persist_result", 29, [[1, "result"]]);

  return JSON.stringify({ "@type": "g:Graph", "@value": { vertices, edges } });
}

describe("Joern flow evaluation", () => {
  it("decodes bounded GraphSON and derives only product-level LangGraph relations", async () => {
    const graph = parseJoernGraphson(fixtureGraphson());
    const manifest = `{
  "python_version": "3.12",
  "dependencies": ["."],
  "graphs": {
    "subject_lookup": "arena.graph:graph"
  }
}\n`;
    const candidate = deriveLangGraphFlow(graph, manifest, "fixture");

    expect(candidate.diagnostics).toEqual([]);
    expect(candidate.entrypoints).toHaveLength(1);
    expect(candidate.relations).toHaveLength(12);
    expect(candidate.paths).toHaveLength(3);
    expect(candidate.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "call",
          source: { path: "arena/nodes.py", symbol: "research" },
          target: { path: "arena/effects.py", symbol: "search_web" },
        }),
        expect.objectContaining({
          kind: "terminal-effect",
          source: { path: "arena/nodes.py", symbol: "finalize" },
          target: { external: "langgraph:END" },
        }),
      ]),
    );

    const oraclePath = fileURLToPath(
      new URL("../../fixtures/eval/python-langgraph-entry-effect/oracle.json", import.meta.url),
    );
    const oracle = await loadEvaluationOracle(oraclePath);
    const scores = scoreFlowGraph(candidate, oracle.entryToEffect!);

    expect(scores.entrypoints).toMatchObject({ precision: 1, recall: 1 });
    expect(scores.relations).toMatchObject({
      expected: 13,
      actual: 12,
      precision: 1,
      recall: 0.923077,
    });
    expect(scores.relations.missing.map((relation) => relation.id)).toEqual(["persist-write"]);
    expect(scores.paths).toMatchObject({ expected: 4, actual: 3, precision: 1, recall: 0.75 });
    expect(scores.entrypointMetadataMismatches).toEqual([]);
    expect(scores.metadataMismatches).toHaveLength(9);
    expect(scores.pathMetadataMismatches).toHaveLength(3);
    expect(flowAcceptanceFailures(scores, oracle.entryToEffect!.thresholds, candidate.diagnostics)).toEqual([]);

    const incorrectlyAnchored = {
      ...candidate,
      entrypoints: candidate.entrypoints.map((entrypoint) => ({
        ...entrypoint,
        registration: { ...entrypoint.registration, startLine: entrypoint.registration.startLine + 1 },
      })),
    };
    const anchoredScores = scoreFlowGraph(incorrectlyAnchored, oracle.entryToEffect!);
    expect(anchoredScores.entrypoints).toMatchObject({ precision: 1, recall: 1 });
    expect(anchoredScores.entrypointMetadataMismatches).toHaveLength(1);
    expect(
      flowAcceptanceFailures(
        anchoredScores,
        oracle.entryToEffect!.thresholds,
        incorrectlyAnchored.diagnostics,
      ),
    ).toContain("1 entrypoint evidence anchor(s) do not match the oracle.");

    const corrupted = {
      ...candidate,
      paths: candidate.paths.map((path, index) =>
        index === 0 ? { ...path, relations: [...path.relations, "missing-relation"] } : path,
      ),
    };
    expect(scoreFlowGraph(corrupted, oracle.entryToEffect!).paths).toMatchObject({
      actual: 3,
      truePositives: 2,
      falsePositives: 1,
      precision: 0.666667,
      recall: 0.5,
    });
  });

  it("follows call targets that own terminal effects", () => {
    const graph = parseJoernGraphson(fixtureGraphson());
    const candidate = deriveLangGraphFlow(
      graph,
      `{"graphs":{"subject_lookup":"arena.graph:graph"}}`,
      "fixture",
    );
    const persistTerminal = {
      id: "fixture-persist-write",
      kind: "terminal-effect" as const,
      source: { path: "arena/effects.py", symbol: "persist_result" },
      target: { external: "result-store" },
      certainty: "asserted" as const,
      evidence: { path: "arena/effects.py", startLine: 10 },
      producer: { id: "fixture-human", version: "1", kind: "human" as const },
    };
    const nestedCall = {
      id: "fixture-persist-audit",
      kind: "call" as const,
      source: { path: "arena/effects.py", symbol: "persist_result" },
      target: { path: "arena/effects.py", symbol: "audit_result" },
      certainty: "exact" as const,
      evidence: { path: "arena/effects.py", startLine: 9 },
      producer: { id: "fixture-compiler", version: "1", kind: "compiler" as const },
    };
    const relations = [...candidate.relations, persistTerminal, nestedCall];
    const diagnostics: string[] = [];
    const paths = enumerateFlowPaths(
      candidate.entrypoints,
      relations,
      persistTerminal.producer,
      diagnostics,
    );
    const relationById = new Map(relations.map((relation) => [relation.id, relation]));
    const persisted = paths.find(
      (path) => relationById.get(path.terminalRelation)?.target &&
        "external" in relationById.get(path.terminalRelation)!.target &&
        relationById.get(path.terminalRelation)!.target.external === "result-store",
    );

    expect(diagnostics).toEqual([]);
    expect(persisted).toBeDefined();
    expect(
      persisted!.relations.map((relation) => relationById.get(relation)?.kind),
    ).toEqual(expect.arrayContaining(["call", "terminal-effect"]));
    expect(persisted!.relations).toContain(nestedCall.id);
    expect(persisted!.relations.at(-1)).toBe(persistTerminal.id);

    const completed = paths.find((path) => {
      const terminal = relationById.get(path.terminalRelation);
      return (
        terminal?.source &&
        "path" in terminal.source &&
        terminal.source.symbol === "finalize" &&
        "external" in terminal.target &&
        terminal.target.external === "langgraph:END"
      );
    });
    expect(completed).toBeDefined();
    expect(completed!.relations).toContain(nestedCall.id);
    expect(completed!.relations.indexOf(nestedCall.id)).toBeLessThan(
      completed!.relations.indexOf(completed!.terminalRelation),
    );
  });

  it("rejects edges that reference vertices absent from the export", () => {
    const invalid = JSON.parse(fixtureGraphson()) as {
      "@value": { edges: Array<{ inV: { "@value": number } }> };
    };
    invalid["@value"].edges[0]!.inV["@value"] = 999_999;
    expect(() => parseJoernGraphson(JSON.stringify(invalid))).toThrow("references a missing vertex");
  });

  it("keeps each manifest entrypoint on its own registration relation", () => {
    const graph = parseJoernGraphson(fixtureGraphson());
    const manifest = `{
  "graphs": {
    "subject_lookup": "arena.graph:graph",
    "subject_lookup_alias": "arena.graph:graph"
  }
}\n`;
    const candidate = deriveLangGraphFlow(graph, manifest, "fixture");
    const relationById = new Map(candidate.relations.map((relation) => [relation.id, relation]));

    expect(candidate.entrypoints).toHaveLength(2);
    expect(candidate.paths).toHaveLength(6);
    for (const entrypoint of candidate.entrypoints) {
      const graphName = entrypoint.id.replaceAll("-", "_");
      const paths = candidate.paths.filter((path) => path.entrypoint === entrypoint.id);
      expect(paths).toHaveLength(3);
      for (const path of paths) {
        expect(relationById.get(path.relations[0]!)).toMatchObject({
          id: entrypoint.registrationRelation,
          kind: "register",
          source: { path: "langgraph.json", symbol: graphName },
        });
      }
    }
  });
});
