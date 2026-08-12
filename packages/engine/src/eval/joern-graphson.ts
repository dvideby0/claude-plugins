import { createHash } from "node:crypto";
import { z } from "zod";
import type { CertaintyClass, FactEdgeKind, FactProducer } from "../facts/model.js";
import {
  flowEntityKey,
  flowRelationKey,
  type CandidateFlowEntrypoint,
  type CandidateFlowGraph,
  type CandidateFlowPath,
  type CandidateFlowRelation,
} from "./flow.js";
import type { FlowEntity } from "./model.js";

const MAX_GRAPHSON_VERTICES = 250_000;
const MAX_GRAPHSON_EDGES = 2_000_000;
const MAX_AST_DEPTH = 128;
const MAX_FLOW_DEPTH = 64;
const MAX_FLOW_PATHS = 128;
const MAX_FLOW_VISITS = 10_000;
const LANGGRAPH_ADAPTER_VERSION = "1";

type Scalar = string | number | boolean | null;

interface JoernNode {
  id: string;
  label: string;
  properties: Record<string, Scalar>;
}

interface JoernEdge {
  out: string;
  in: string;
  label: string;
}

export interface JoernGraph {
  nodes: Map<string, JoernNode>;
  edges: JoernEdge[];
  vertexCount: number;
  edgeCount: number;
}

interface MethodInfo {
  id: string;
  name: string;
  fullName: string;
  path: string;
  startLine: number;
}

interface CallInfo {
  node: JoernNode;
  name: string;
  methodFullName: string;
  source: MethodInfo | null;
  startLine: number | null;
}

const langGraphManifestSchema = z
  .object({ graphs: z.record(z.string().min(1)) })
  .passthrough();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapGraphson(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 12; depth++) {
    const object = record(current);
    if (!object || !("@value" in object)) return current;
    current = object["@value"];
  }
  throw new Error("GraphSON wrapper nesting exceeds the evaluation bound.");
}

function scalar(value: unknown): Scalar {
  let decoded = unwrapGraphson(value);
  if (Array.isArray(decoded)) decoded = decoded.length === 0 ? null : unwrapGraphson(decoded[0]);
  if (
    decoded === null ||
    typeof decoded === "string" ||
    typeof decoded === "number" ||
    typeof decoded === "boolean"
  ) {
    return decoded;
  }
  return null;
}

function requiredString(value: unknown, label: string): string {
  const decoded = scalar(value);
  if (typeof decoded !== "string" || decoded.length === 0) {
    throw new Error(`Joern GraphSON ${label} must be a non-empty string.`);
  }
  return decoded;
}

function graphId(value: unknown, label: string): string {
  const decoded = scalar(value);
  if ((typeof decoded !== "string" && typeof decoded !== "number") || String(decoded).length === 0) {
    throw new Error(`Joern GraphSON ${label} must be a string or number.`);
  }
  if (typeof decoded === "number" && !Number.isSafeInteger(decoded)) {
    throw new Error(`Joern GraphSON ${label} exceeds JavaScript's safe integer range.`);
  }
  return String(decoded);
}

function decodeProperties(value: unknown): Record<string, Scalar> {
  const object = record(value);
  if (!object) return {};
  return Object.fromEntries(Object.entries(object).map(([key, raw]) => [key, scalar(raw)]));
}

/** Decode only the stable vertex/edge/property subset needed by the spike. */
export function parseJoernGraphson(contents: string): JoernGraph {
  const parsed = JSON.parse(contents) as unknown;
  const root = record(unwrapGraphson(parsed));
  if (!root || !Array.isArray(root.vertices) || !Array.isArray(root.edges)) {
    throw new Error("Joern GraphSON must contain vertex and edge arrays.");
  }
  if (root.vertices.length > MAX_GRAPHSON_VERTICES) {
    throw new Error(`Joern GraphSON has ${root.vertices.length} vertices; maximum is ${MAX_GRAPHSON_VERTICES}.`);
  }
  if (root.edges.length > MAX_GRAPHSON_EDGES) {
    throw new Error(`Joern GraphSON has ${root.edges.length} edges; maximum is ${MAX_GRAPHSON_EDGES}.`);
  }

  const nodes = new Map<string, JoernNode>();
  for (const [index, raw] of root.vertices.entries()) {
    const vertex = record(raw);
    if (!vertex) throw new Error(`Joern GraphSON vertex ${index} is not an object.`);
    const node: JoernNode = {
      id: graphId(vertex.id, `vertex ${index} id`),
      label: requiredString(vertex.label, `vertex ${index} label`),
      properties: decodeProperties(vertex.properties),
    };
    if (nodes.has(node.id)) throw new Error(`Duplicate Joern GraphSON vertex id: ${node.id}`);
    nodes.set(node.id, node);
  }

  const edges = root.edges.map((raw, index): JoernEdge => {
    const edge = record(raw);
    if (!edge) throw new Error(`Joern GraphSON edge ${index} is not an object.`);
    const decoded = {
      out: graphId(edge.outV, `edge ${index} outV`),
      in: graphId(edge.inV, `edge ${index} inV`),
      label: requiredString(edge.label, `edge ${index} label`),
    };
    if (!nodes.has(decoded.out) || !nodes.has(decoded.in)) {
      throw new Error(`Joern GraphSON edge ${index} references a missing vertex.`);
    }
    return decoded;
  });

  return { nodes, edges, vertexCount: nodes.size, edgeCount: edges.length };
}

function propertyString(node: JoernNode, property: string): string | null {
  const value = node.properties[property];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function propertyNumber(node: JoernNode, property: string): number | null {
  const value = node.properties[property];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function portableSourcePath(path: string): string | null {
  const portable = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const mounted = portable.startsWith("/input/") ? portable.slice("/input/".length) : portable;
  if (
    mounted.length === 0 ||
    mounted === "<empty>" ||
    mounted.startsWith("/") ||
    mounted === ".." ||
    mounted.startsWith("../") ||
    mounted.includes("/../")
  ) {
    return null;
  }
  return mounted;
}

function entity(method: MethodInfo): FlowEntity {
  return { path: method.path, symbol: method.name };
}

function relationId(relation: Pick<CandidateFlowRelation, "kind" | "source" | "target">): string {
  return `flow-${createHash("sha256").update(flowRelationKey(relation)).digest("hex").slice(0, 16)}`;
}

function sourceLine(node: JoernNode): number | null {
  const oneBased = propertyNumber(node, "LINE_NUMBER");
  return oneBased === null || oneBased < 1 ? null : Math.trunc(oneBased) - 1;
}

function methodIndex(graph: JoernGraph): {
  methods: MethodInfo[];
  byId: Map<string, MethodInfo>;
  byFullName: Map<string, MethodInfo[]>;
  byName: Map<string, MethodInfo[]>;
} {
  const methods = [...graph.nodes.values()].flatMap((node): MethodInfo[] => {
    if (node.label !== "METHOD") return [];
    const name = propertyString(node, "NAME");
    const fullName = propertyString(node, "FULL_NAME");
    const path = propertyString(node, "FILENAME");
    const portable = path ? portableSourcePath(path) : null;
    const startLine = sourceLine(node);
    if (!name || !fullName || !portable || startLine === null || name === "<module>") return [];
    return [{ id: node.id, name, fullName, path: portable, startLine }];
  });
  const byId = new Map(methods.map((method) => [method.id, method]));
  const group = (key: (method: MethodInfo) => string): Map<string, MethodInfo[]> => {
    const result = new Map<string, MethodInfo[]>();
    for (const method of methods) result.set(key(method), [...(result.get(key(method)) ?? []), method]);
    return result;
  };
  return { methods, byId, byFullName: group((method) => method.fullName), byName: group((method) => method.name) };
}

function callIndex(graph: JoernGraph, byMethodId: Map<string, MethodInfo>): {
  calls: CallInfo[];
  argumentsByCall: Map<string, JoernNode[]>;
} {
  const parentByAstChild = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.label !== "AST") continue;
    const existing = parentByAstChild.get(edge.in);
    if (existing && existing !== edge.out) {
      throw new Error(`Joern AST node ${edge.in} has more than one parent.`);
    }
    parentByAstChild.set(edge.in, edge.out);
  }
  const argumentsByCall = new Map<string, JoernNode[]>();
  for (const edge of graph.edges) {
    if (edge.label !== "ARGUMENT") continue;
    const argument = graph.nodes.get(edge.in);
    if (!argument) continue;
    argumentsByCall.set(edge.out, [...(argumentsByCall.get(edge.out) ?? []), argument]);
  }
  for (const arguments_ of argumentsByCall.values()) {
    arguments_.sort(
      (left, right) =>
        (propertyNumber(left, "ARGUMENT_INDEX") ?? Number.MAX_SAFE_INTEGER) -
        (propertyNumber(right, "ARGUMENT_INDEX") ?? Number.MAX_SAFE_INTEGER),
    );
  }

  const enclosingMethod = (node: JoernNode): MethodInfo | null => {
    let current = node.id;
    for (let depth = 0; depth < MAX_AST_DEPTH; depth++) {
      const parent = parentByAstChild.get(current);
      if (!parent) return null;
      const method = byMethodId.get(parent);
      if (method) return method;
      current = parent;
    }
    throw new Error(`Joern AST ancestry exceeds ${MAX_AST_DEPTH} nodes.`);
  };

  const calls = [...graph.nodes.values()].flatMap((node): CallInfo[] => {
    if (node.label !== "CALL") return [];
    const name = propertyString(node, "NAME");
    const methodFullName = propertyString(node, "METHOD_FULL_NAME");
    if (!name || !methodFullName) return [];
    return [{ node, name, methodFullName, source: enclosingMethod(node), startLine: sourceLine(node) }];
  });
  return { calls, argumentsByCall };
}

function argumentAt(call: CallInfo, index: number, argumentsByCall: Map<string, JoernNode[]>): JoernNode | null {
  return (
    (argumentsByCall.get(call.node.id) ?? []).find(
      (argument) => propertyNumber(argument, "ARGUMENT_INDEX") === index,
    ) ?? null
  );
}

function stringLiteral(code: string | null): string | null {
  if (!code || code.length < 2) return null;
  if (code.startsWith('"') && code.endsWith('"')) {
    try {
      const decoded = JSON.parse(code) as unknown;
      return typeof decoded === "string" ? decoded : null;
    } catch {
      return null;
    }
  }
  if (code.startsWith("'") && code.endsWith("'")) {
    const body = code.slice(1, -1);
    return body.includes("\\") ? null : body;
  }
  return null;
}

function endpointToken(node: JoernNode | null): string | null {
  if (!node) return null;
  const code = propertyString(node, "CODE")?.trim() ?? null;
  return stringLiteral(code) ?? code;
}

function listEndpoints(node: JoernNode | null, argumentsByCall: Map<string, JoernNode[]>): string[] {
  if (!node) return [];
  const children = argumentsByCall.get(node.id) ?? [];
  if (children.length > 0) return children.flatMap((child) => endpointToken(child) ?? []);
  const code = propertyString(node, "CODE")?.trim();
  if (!code?.startsWith("[") || !code.endsWith("]")) return [];
  return code
    .slice(1, -1)
    .split(",")
    .map((value) => value.trim())
    .flatMap((value) => stringLiteral(value) ?? (value ? value : []));
}

function manifestLine(contents: string, graphName: string): number {
  const needle = JSON.stringify(graphName);
  const line = contents.split(/\r?\n/).findIndex((candidate) => candidate.includes(needle));
  if (line < 0) throw new Error(`Could not anchor LangGraph manifest entry ${graphName}.`);
  return line;
}

function manifestTarget(value: string): FlowEntity | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const moduleName = value.slice(0, separator);
  const symbol = value.slice(separator + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(moduleName) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) {
    return null;
  }
  return { path: `${moduleName.replaceAll(".", "/")}.py`, symbol };
}

function addRelation(
  relations: Map<string, CandidateFlowRelation>,
  kind: FactEdgeKind,
  source: FlowEntity,
  target: FlowEntity,
  certainty: CertaintyClass,
  path: string,
  startLine: number,
  producer: FactProducer,
): CandidateFlowRelation {
  const identity = { kind, source, target };
  const key = flowRelationKey(identity);
  const existing = relations.get(key);
  if (existing) return existing;
  const relation: CandidateFlowRelation = {
    id: relationId(identity),
    kind,
    source,
    target,
    certainty,
    evidence: { path, startLine },
    producer,
  };
  relations.set(key, relation);
  return relation;
}

export function enumerateFlowPaths(
  entrypoints: CandidateFlowEntrypoint[],
  relations: CandidateFlowRelation[],
  producer: FactProducer,
  diagnostics: string[],
): CandidateFlowPath[] {
  const outgoing = new Map<string, CandidateFlowRelation[]>();
  for (const relation of relations) {
    const key = flowEntityKey(relation.source);
    outgoing.set(key, [...(outgoing.get(key) ?? []), relation]);
  }
  for (const values of outgoing.values()) {
    values.sort(
      (left, right) =>
        left.evidence.startLine - right.evidence.startLine || flowRelationKey(left).localeCompare(flowRelationKey(right)),
    );
  }

  const paths: CandidateFlowPath[] = [];
  let visits = 0;
  let traversalStopped = false;
  const stopTraversal = (message: string): true => {
    traversalStopped = true;
    if (!diagnostics.includes(message)) diagnostics.push(message);
    return true;
  };
  const reachedTraversalBound = (): boolean => {
    if (traversalStopped) return true;
    if (paths.length >= MAX_FLOW_PATHS) {
      return stopTraversal(`Flow path enumeration reached the ${MAX_FLOW_PATHS}-path bound.`);
    }
    if (visits >= MAX_FLOW_VISITS) {
      return stopTraversal(`Flow traversal reached the ${MAX_FLOW_VISITS}-visit bound.`);
    }
    return false;
  };
  const emit = (entrypoint: CandidateFlowEntrypoint, relationIds: string[], terminal: string): void => {
    if (reachedTraversalBound()) return;
    const selected = relationIds.flatMap((id) => relations.find((relation) => relation.id === id) ?? []);
    paths.push({
      id: `path-${createHash("sha256").update(`${entrypoint.id}\0${relationIds.join("\0")}`).digest("hex").slice(0, 16)}`,
      entrypoint: entrypoint.id,
      relations: relationIds,
      terminalRelation: terminal,
      conditions: [],
      certainty: selected.every((relation) => relation.certainty === "exact") ? "exact" : "inferred",
      producer,
    });
  };

  const walk = (
    entrypoint: CandidateFlowEntrypoint,
    current: FlowEntity,
    prefix: string[],
    visited: Set<string>,
    depth: number,
  ): string[] => {
    if (reachedTraversalBound()) return prefix;
    visits += 1;
    if (depth > MAX_FLOW_DEPTH) {
      diagnostics.push(`Flow traversal for ${entrypoint.id} exceeded ${MAX_FLOW_DEPTH} relations.`);
      return prefix;
    }
    const currentKey = flowEntityKey(current);
    if (visited.has(currentKey)) {
      diagnostics.push(`Flow traversal for ${entrypoint.id} stopped at cycle ${currentKey}.`);
      return prefix;
    }
    const nextVisited = new Set(visited).add(currentKey);
    const next = outgoing.get(currentKey) ?? [];
    const calls = next.filter((relation) => relation.kind === "call");
    const transitions = next.filter((relation) => relation.kind !== "call" && relation.kind !== "register");
    let continuation = prefix;
    for (const call of calls) {
      if (reachedTraversalBound()) break;
      continuation = walk(
        entrypoint,
        call.target,
        [...continuation, call.id],
        nextVisited,
        depth + 1,
      );
    }
    for (const transition of transitions) {
      if (reachedTraversalBound()) break;
      const sequence = [...continuation, transition.id];
      if (transition.kind === "terminal-effect") emit(entrypoint, sequence, transition.id);
      else walk(entrypoint, transition.target, sequence, nextVisited, depth + 1);
    }
    return continuation;
  };

  for (const entrypoint of entrypoints) {
    if (traversalStopped) break;
    const registration = relations.find((relation) => relation.id === entrypoint.registrationRelation);
    if (!registration) {
      diagnostics.push(`No manifest registration relation was found for ${entrypoint.id}.`);
      continue;
    }
    walk(entrypoint, entrypoint.target, [registration.id], new Set(), 1);
  }
  return paths;
}

/**
 * Add LangGraph deployment and dispatch semantics on top of Joern's methods,
 * calls, arguments, and source anchors. No generic Python resolver lives here.
 */
export function deriveLangGraphFlow(
  graph: JoernGraph,
  manifestContents: string,
  joernVersion: string,
): CandidateFlowGraph {
  const manifest = langGraphManifestSchema.parse(JSON.parse(manifestContents));
  const diagnostics: string[] = [];
  const methodData = methodIndex(graph);
  const callData = callIndex(graph, methodData.byId);
  const cpgProducer: FactProducer = { id: "joern-cpg", version: joernVersion, kind: "compiler" };
  const frameworkProducer: FactProducer = {
    id: "langgraph-cpg-adapter",
    version: LANGGRAPH_ADAPTER_VERSION,
    kind: "framework",
  };
  const manifestProducer: FactProducer = {
    id: "langgraph-manifest",
    version: LANGGRAPH_ADAPTER_VERSION,
    kind: "parsed",
  };
  const relations = new Map<string, CandidateFlowRelation>();
  const entrypoints: CandidateFlowEntrypoint[] = [];

  for (const [graphName, manifestReference] of Object.entries(manifest.graphs).sort()) {
    const target = manifestTarget(manifestReference);
    if (!target || !("path" in target)) {
      diagnostics.push(`Unsupported LangGraph manifest target for ${graphName}: ${manifestReference}`);
      continue;
    }
    const registrationLine = manifestLine(manifestContents, graphName);
    const registrationRelation = addRelation(
      relations,
      "register",
      { path: "langgraph.json", symbol: graphName },
      target,
      "exact",
      "langgraph.json",
      registrationLine,
      manifestProducer,
    );
    const entrypoint: CandidateFlowEntrypoint = {
      id: graphName.replaceAll("_", "-"),
      registration: { path: "langgraph.json", startLine: registrationLine },
      registrationRelation: registrationRelation.id,
      target,
      producer: manifestProducer,
    };
    entrypoints.push(entrypoint);

    const stateMethodNames = new Set(["add_node", "add_edge", "add_conditional_edges"]);
    const stateCalls = callData.calls.filter(
      (call) =>
        call.source?.path === target.path &&
        stateMethodNames.has(call.name) &&
        call.methodFullName === `langgraph/graph.py:<module>.StateGraph.${call.name}`,
    );
    const owners = new Set(
      stateCalls.flatMap((call) => (call.source ? [call.source.fullName] : [])),
    );
    if (owners.size !== 1) {
      diagnostics.push(
        `Expected one unambiguous StateGraph builder for ${graphName}; found ${owners.size}.`,
      );
      continue;
    }

    const registered = new Map<string, MethodInfo>();
    for (const call of stateCalls.filter((candidate) => candidate.name === "add_node")) {
      const labelArgument = argumentAt(call, 1, callData.argumentsByCall);
      const label = stringLiteral(labelArgument ? propertyString(labelArgument, "CODE") : null);
      const functionName = endpointToken(argumentAt(call, 2, callData.argumentsByCall));
      const candidates = functionName ? methodData.byName.get(functionName) ?? [] : [];
      if (!label || candidates.length !== 1) {
        diagnostics.push(
          `Could not resolve LangGraph node registration at ${call.source?.path ?? "unknown"}:${(call.startLine ?? -1) + 1}.`,
        );
        continue;
      }
      registered.set(label, candidates[0]!);
    }

    const registeredMethods = new Set([...registered.values()].map((method) => method.fullName));
    for (const call of callData.calls) {
      if (!call.source || call.startLine === null || !registeredMethods.has(call.source.fullName)) continue;
      const targets = methodData.byFullName.get(call.methodFullName) ?? [];
      if (targets.length !== 1) continue;
      addRelation(
        relations,
        "call",
        entity(call.source),
        entity(targets[0]!),
        "exact",
        call.source.path,
        call.startLine,
        cpgProducer,
      );
    }

    const endpointEntity = (token: string): FlowEntity | null => registered.has(token) ? entity(registered.get(token)!) : null;
    for (const call of stateCalls.filter((candidate) => candidate.name !== "add_node")) {
      if (!call.source || call.startLine === null) continue;
      const sourceToken = endpointToken(argumentAt(call, 1, callData.argumentsByCall));
      if (!sourceToken) continue;
      const source = sourceToken === "START" ? target : endpointEntity(sourceToken);
      if (!source) {
        diagnostics.push(`Unknown LangGraph source node ${sourceToken} at ${call.source.path}:${call.startLine + 1}.`);
        continue;
      }
      if (call.name === "add_edge") {
        const targetToken = endpointToken(argumentAt(call, 2, callData.argumentsByCall));
        const destination = targetToken === "END" ? { external: "langgraph:END" } : targetToken ? endpointEntity(targetToken) : null;
        if (!destination) {
          diagnostics.push(`Unknown LangGraph target node at ${call.source.path}:${call.startLine + 1}.`);
          continue;
        }
        addRelation(
          relations,
          targetToken === "END" ? "terminal-effect" : "dispatch",
          source,
          destination,
          "inferred",
          call.source.path,
          call.startLine,
          frameworkProducer,
        );
        continue;
      }

      const routerName = endpointToken(argumentAt(call, 2, callData.argumentsByCall));
      const routerCandidates = routerName ? methodData.byName.get(routerName) ?? [] : [];
      if (routerCandidates.length !== 1) {
        diagnostics.push(`Could not resolve LangGraph router at ${call.source.path}:${call.startLine + 1}.`);
        continue;
      }
      const router = entity(routerCandidates[0]!);
      addRelation(
        relations,
        "dispatch",
        source,
        router,
        "inferred",
        call.source.path,
        call.startLine,
        frameworkProducer,
      );
      for (const targetToken of listEndpoints(argumentAt(call, 3, callData.argumentsByCall), callData.argumentsByCall)) {
        const destination = targetToken === "END" ? { external: "langgraph:END" } : endpointEntity(targetToken);
        if (!destination) {
          diagnostics.push(`Unknown LangGraph conditional target ${targetToken} at ${call.source.path}:${call.startLine + 1}.`);
          continue;
        }
        addRelation(
          relations,
          targetToken === "END" ? "terminal-effect" : "branch",
          router,
          destination,
          "inferred",
          call.source.path,
          call.startLine,
          frameworkProducer,
        );
      }
    }
  }

  const relationList = [...relations.values()];
  return {
    entrypoints,
    relations: relationList,
    paths: enumerateFlowPaths(entrypoints, relationList, frameworkProducer, diagnostics),
    diagnostics,
  };
}
