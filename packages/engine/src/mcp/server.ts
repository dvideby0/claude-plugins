/**
 * The MCP surface of the engine.
 *
 * All state lives in each workspace's app-owned audit.db, so every tool is independently
 * callable and a restarted engine resumes exactly where it left off. That is
 * what lets one tool set serve a single project over stdio or many projects
 * at once over HTTP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import { z } from "zod";
import { runAnalyzers } from "../analyze/run.js";
import { contentDir } from "../content.js";
import { getDb } from "../db/db.js";
import { extractSnippet } from "../findings/fingerprint.js";
import { recordFindings, suppress } from "../findings/record.js";
import { CATEGORIES, CONFIDENCES, SEVERITIES, type FindingInput } from "../findings/types.js";
import { buildBrief } from "../graph/brief.js";
import { resolveTypesInWorker } from "../graph/typed.js";
import { CROSS_KINDS, crossQuery, type CrossKind, type WorkspaceRef } from "../graph/cross.js";
import { impactOf, referencesTo } from "../graph/refs.js";
import { flowView } from "../graph/flow.js";
import { findGaps } from "../graph/gaps.js";
import {
  COMPONENT_KINDS,
  describeComponent,
  describeFlow,
  finalizeMap,
  mapDrift,
  systemMap,
  tagNode,
} from "../graph/map.js";
import { listRelations, markExplored, relate, relationsFor, RELATION_KINDS } from "../graph/relations.js";
import { PATTERNS, structuralSearch } from "../graph/structural.js";
import { trace } from "../graph/trace.js";
import { neighbourhood } from "../memory/context.js";
import { forget, listMemories, MEMORY_KINDS, recall, remember } from "../memory/store.js";
import { buildContext } from "../plan/context.js";
import { QUERY_KINDS, runQuery, type QueryKind } from "../plan/query.js";
import { loadPlan, planUnits, savePlan } from "../plan/risk.js";
import { buildReports } from "../report/export.js";
import { runReview } from "../review/runner.js";
import { scan } from "../scan/scan.js";
import { readWorkspaceText } from "../lib/workspace-path.js";

export const ENGINE_VERSION = "0.1.0";

export interface McpServerOptions {
  /**
   * Root to fall back on when a caller omits projectRoot. The stdio entry
   * passes its cwd; the daemon passes null, because its own cwd means nothing
   * to the repository being audited.
   */
  defaultRoot: string | null;
  /** Called with every project root a tool touches, so the registry can learn it. */
  onWorkspaceTouched?: (root: string) => void;
  /** Publish successful MCP writes to desktop clients sharing the registry. */
  onWorkspaceChanged?: (
    root: string,
    kind: "indexed" | "updated",
  ) => void | Promise<void>;
  /**
   * Every repository the engine knows. Only the daemon can supply this, which
   * is why cross-repository search is unavailable over stdio.
   */
  listWorkspaces?: () => Promise<WorkspaceRef[]>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** Every tool body runs through here so failures return a readable envelope. */
async function wrap(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: true, message: error instanceof Error ? error.message : String(error) },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
}

const projectRootArg = {
  projectRoot: z
    .string()
    .optional()
    .describe("Absolute path to the repository. Supplied automatically by the plugin bridge."),
};

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: "sdlc", version: ENGINE_VERSION });
  const CONTENT = contentDir();

  function resolveRoot(projectRoot?: string): string {
    const root = projectRoot ?? process.env.AUDIT_PROJECT_ROOT ?? options.defaultRoot;
    if (!root) {
      throw new Error(
        "No projectRoot given. The engine serves many repositories, so a tool must say which one.",
      );
    }
    // Normalised, so `/repo` and `/repo/` are one workspace — unnormalised
    // they open two live handles over one store file, and the second flush
    // silently overwrites everything the first one wrote.
    const absolute = resolve(root);
    options.onWorkspaceTouched?.(absolute);
    return absolute;
  }

  async function workspaceChanged(root: string, kind: "indexed" | "updated"): Promise<void> {
    await options.onWorkspaceChanged?.(root, kind);
  }

  // --- audit_status --------------------------------------------------------

  server.tool(
    "audit_status",
    "Report what the audit store already knows: last run, indexed files, open findings, and the next step.",
    projectRootArg,
    async ({ projectRoot }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);

        const files = db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1");
        const lastRun = db.get<{
          id: number;
          kind: string;
          started_at: string;
          git_sha: string | null;
        }>("SELECT id, kind, started_at, git_sha FROM runs ORDER BY id DESC LIMIT 1");
        const bySeverity = db.all<{ severity: string; n: number }>(
          "SELECT severity, COUNT(*) AS n FROM findings WHERE status IN ('open','regressed') GROUP BY severity",
        );

        const next =
          files === 0
            ? "audit_scan"
            : db.count("SELECT COUNT(*) AS n FROM tool_runs") === 0
              ? "audit_run_tools"
              : loadPlan(db).length === 0
                ? "audit_plan"
                : "audit_report";

        return {
          projectRoot: root,
          indexedFiles: files,
          symbols: db.count("SELECT COUNT(*) AS n FROM symbols"),
          edges: db.count("SELECT COUNT(*) AS n FROM edges"),
          openFindings: db.count(
            "SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','regressed')",
          ),
          fixedFindings: db.count("SELECT COUNT(*) AS n FROM findings WHERE status = 'fixed'"),
          suppressed: db.count("SELECT COUNT(*) AS n FROM suppressions"),
          openBySeverity: Object.fromEntries(bySeverity.map((row) => [row.severity, row.n])),
          lastRun,
          plannedUnits: loadPlan(db).length,
          suggestedNext: next,
        };
      }),
  );

  // --- audit_scan ----------------------------------------------------------

  server.tool(
    "audit_scan",
    "Index the repository: walk files, extract symbols and imports with tree-sitter, resolve the dependency graph. Incremental — unchanged files are skipped.",
    {
      ...projectRootArg,
      full: z.boolean().optional().describe("Re-parse every file, ignoring content hashes."),
    },
    async ({ projectRoot, full }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const result = await scan(root, { full, kind: full ? "full" : "incremental" });
        await workspaceChanged(root, "indexed");
        return result;
      }),
  );

  // --- audit_run_tools -----------------------------------------------------

  server.tool(
    "audit_run_tools",
    "Run deterministic analysis: the project's own linters and type checkers, secret scanning, dependency advisories, and import-cycle detection. Records findings.",
    {
      ...projectRootArg,
      offline: z.boolean().optional().describe("Skip the OSV advisory lookup."),
    },
    async ({ projectRoot, offline }, extra) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const result = await runAnalyzers(root, { offline, signal: extra.signal });
        await workspaceChanged(root, "updated");
        return result;
      }),
  );

  // --- audit_plan ----------------------------------------------------------

  server.tool(
    "audit_plan",
    "Rank files by risk (blast radius, churn, open findings, test coverage, size) and group them into review units for sub-agents.",
    {
      ...projectRootArg,
      tokenBudget: z.number().optional().describe("Context budget per unit. Default 60000."),
      maxUnits: z.number().optional().describe("Maximum review units. Default 20."),
    },
    async ({ projectRoot, tokenBudget, maxUnits }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const units = planUnits(db, { tokenBudget, maxUnits });
        savePlan(db, units);
        await db.flush();
        await workspaceChanged(root, "updated");
        return { units, totalUnits: units.length };
      }),
  );

  // --- audit_context -------------------------------------------------------

  server.tool(
    "audit_context",
    "Build the review prompt for one unit: rules, findings already known, graph neighbourhood, and source packed to budget.",
    {
      ...projectRootArg,
      unitId: z.string().describe("Unit id from audit_plan, e.g. 'unit-01'."),
      tokenBudget: z.number().optional().describe("Context budget. Default 60000."),
      lens: z
        .enum(["security", "correctness", "testing", "performance"])
        .optional()
        .describe("Focus the review on one domain."),
    },
    async ({ projectRoot, unitId, tokenBudget, lens }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const unit = loadPlan(db).find((candidate) => candidate.id === unitId);
        if (!unit) {
          const available = loadPlan(db).map((candidate) => candidate.id);
          throw new Error(
            available.length === 0
              ? "No plan found. Call audit_plan first."
              : `Unknown unit "${unitId}". Available: ${available.join(", ")}`,
          );
        }
        return buildContext(db, unit, {
          projectRoot: root,
          pluginRoot: CONTENT,
          tokenBudget,
          lens,
        });
      }),
  );

  // --- audit_record_findings -----------------------------------------------

  const findingSchema = z.object({
    ruleId: z.string().min(1).describe("Stable slug, e.g. 'llm/unchecked-nullable'."),
    category: z.enum(CATEGORIES),
    severity: z.enum(SEVERITIES),
    confidence: z.enum(CONFIDENCES),
    title: z.string().min(1),
    description: z.string().optional(),
    suggestion: z.string().optional(),
    path: z.string().optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    symbol: z.string().optional().describe("Enclosing function or class, if known."),
  });

  server.tool(
    "audit_record_findings",
    "Record review findings. Deduplicated by fingerprint, suppressions applied, statuses maintained. This is the only way agents write findings.",
    {
      ...projectRootArg,
      findings: z.array(findingSchema).describe("Findings to record."),
    },
    async ({ projectRoot, findings }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const runId =
          db.get<{ id: number }>("SELECT id FROM runs ORDER BY id DESC LIMIT 1")?.id ?? 0;

        // Snippets come from the file itself, not from the agent — and only
        // from files inside the workspace. An agent-supplied "../" path would
        // otherwise read anything user-readable and persist it in the store.
        const enriched: FindingInput[] = [];
        for (const finding of findings) {
          let snippet: string | undefined;
          if (finding.path && finding.lineStart) {
            try {
              const content = await readWorkspaceText(root, finding.path);
              snippet = extractSnippet(content, finding.lineStart, finding.lineEnd);
            } catch {
              // Outside the workspace or unreadable — fingerprint falls back
              // to the title, and no local file contents enter the store.
            }
          }
          enriched.push({ ...finding, source: "llm", snippet });
        }

        const summary = recordFindings(db, runId, enriched);
        await db.flush();
        await workspaceChanged(root, "updated");
        return summary;
      }),
  );

  // --- audit_query ---------------------------------------------------------

  server.tool(
    "audit_query",
    "Query the audit store: review rules, symbol definitions, importers, imports, findings, hotspots, external packages, cycles.",
    {
      ...projectRootArg,
      kind: z.enum(QUERY_KINDS),
      arg: z
        .string()
        .optional()
        .describe(
          "Rule id, symbol name, file path, or filter value. Omit with kind 'rule' to list every rule.",
        ),
      limit: z.number().optional(),
    },
    async ({ projectRoot, kind, arg, limit }) =>
      wrap(async () => {
        const db = await getDb(resolveRoot(projectRoot));
        const rows = await runQuery({ db, pluginRoot: CONTENT }, kind as QueryKind, arg, limit);
        return { kind, rows };
      }),
  );

  // --- audit_suppress ------------------------------------------------------

  server.tool(
    "audit_suppress",
    "Mark a finding accepted or a false positive, or silence a rule under a path. Suppressions persist across runs.",
    {
      ...projectRootArg,
      findingId: z.string().optional().describe("Suppress this exact finding."),
      ruleId: z.string().optional().describe("Suppress a rule, optionally scoped by pathPrefix."),
      pathPrefix: z.string().optional(),
      reason: z.string().min(1),
      disposition: z
        .enum(["accepted", "false_positive"])
        .optional()
        .describe("Human decision for an exact finding. Defaults to false_positive."),
    },
    async ({ projectRoot, findingId, ruleId, pathPrefix, reason, disposition }) =>
      wrap(async () => {
        if (!findingId && !ruleId) throw new Error("Provide findingId or ruleId.");
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        suppress(db, { findingId, ruleId, pathPrefix, reason, disposition });
        await db.flush();
        await workspaceChanged(root, "updated");
        return { suppressed: findingId ?? `${ruleId}${pathPrefix ? ` under ${pathPrefix}` : ""}` };
      }),
  );

  // --- audit_report --------------------------------------------------------

  server.tool(
    "audit_report",
    "Return the audit report, repository map and task list from the store. Nothing is written to disk — the app renders the same content.",
    projectRootArg,
    async ({ projectRoot }) =>
      wrap(async () => buildReports(await getDb(resolveRoot(projectRoot)))),
  );

  // --- context -------------------------------------------------------------

  server.tool(
    "context",
    "Everything known about a file or symbol before you change it: what it is, what depends on it, open findings, and what previous sessions recorded about it. Call this first when working on unfamiliar code.",
    {
      ...projectRootArg,
      target: z
        .string()
        .describe("File path, a path suffix like 'db.ts', or a symbol name."),
      limit: z.number().optional().describe("Max items per section. Default 40."),
    },
    async ({ projectRoot, target, limit }) =>
      wrap(async () => {
        const db = await getDb(resolveRoot(projectRoot));
        return neighbourhood(db, target, limit);
      }),
  );

  // --- references ----------------------------------------------------------

  server.tool(
    "references",
    "Every place a symbol is used, with file and line. Answers 'who calls this function' — not just which files import its module.",
    {
      ...projectRootArg,
      name: z.string().describe("Symbol name, e.g. 'getDb'."),
      limit: z.number().optional(),
      path: z.string().optional().describe("Declaration path when the name is ambiguous."),
      line: z.number().int().positive().optional().describe("Declaration line within path."),
      symbolId: z.string().optional().describe("Exact declaration id returned in candidates."),
    },
    async ({ projectRoot, name, limit, path, line, symbolId }) =>
      wrap(async () =>
        referencesTo(await getDb(resolveRoot(projectRoot)), name, limit, {
          ...(path ? { path } : {}),
          ...(line ? { line } : {}),
          ...(symbolId ? { symbolId } : {}),
        }),
      ),
  );

  // --- trace ---------------------------------------------------------------

  server.tool(
    "trace",
    "Follow the call chain from a symbol — what it calls, transitively, or what calls it. This is the tool for 'trace this endpoint': imports only say a file can see another, never that A calls B calls C.",
    {
      ...projectRootArg,
      symbol: z.string().describe("Where to start, e.g. a route handler."),
      direction: z
        .enum(["callees", "callers"])
        .optional()
        .describe("callees = what it calls (default). callers = what reaches it."),
      depth: z.number().optional().describe("Hops to follow. Default 4, max 10."),
      path: z.string().optional().describe("Disambiguate when the name is defined more than once."),
      line: z.number().int().positive().optional().describe("Declaration line for same-named symbols in one file."),
      symbolId: z.string().optional().describe("Exact declaration id returned by flow or context."),
    },
    async ({ projectRoot, symbol, direction, depth, path, line, symbolId }) =>
      wrap(async () => {
        const db = await getDb(resolveRoot(projectRoot));
        return trace(db, symbol, {
          ...(direction ? { direction } : {}),
          ...(depth ? { depth } : {}),
          ...(path ? { path } : {}),
          ...(line ? { line } : {}),
          ...(symbolId ? { symbolId } : {}),
        });
      }),
  );

  // --- read_file -----------------------------------------------------------

  server.tool(
    "read_file",
    "Read a bounded, numbered slice of a text file inside the current workspace. Paths that escape through .. or symlinks are rejected.",
    {
      ...projectRootArg,
      path: z.string().min(1).describe("Repository-relative file path."),
      startLine: z.number().int().positive().optional().describe("First line, inclusive. Default 1."),
      endLine: z.number().int().positive().optional().describe("Last line, inclusive. At most 400 lines are returned."),
    },
    async ({ projectRoot, path, startLine, endLine }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const content = await readWorkspaceText(root, path);
        const lines = content.split("\n");
        const from = startLine ?? 1;
        if (from > lines.length) {
          throw new Error(`startLine ${from} is past the end of ${path} (${lines.length} lines).`);
        }
        const requestedEnd = endLine ?? Math.min(lines.length, from + 399);
        if (requestedEnd < from) throw new Error("endLine must be greater than or equal to startLine.");
        const to = Math.min(lines.length, requestedEnd, from + 399);
        let text = lines
          .slice(from - 1, to)
          .map((line, index) => `${String(from + index).padStart(5)}  ${line}`)
          .join("\n");
        const characterLimit = 50_000;
        const characterTruncated = text.length > characterLimit;
        if (characterTruncated) text = text.slice(0, characterLimit);
        return {
          path,
          startLine: from,
          endLine: to,
          totalLines: lines.length,
          truncated: to < requestedEnd || to < lines.length || characterTruncated,
          content: text,
        };
      }),
  );

  // --- map -----------------------------------------------------------------

  server.tool(
    "map",
    "The system as someone would draw it: named components, the flows through them, and cross-cutting tags. This is the interpreted map, not the file graph — read it first when you do not know a codebase. Coverage says how much has been explained.",
    projectRootArg,
    async ({ projectRoot }) => wrap(async () => systemMap(await getDb(resolveRoot(projectRoot)))),
  );

  // --- map_drift -----------------------------------------------------------

  server.tool(
    "map_drift",
    "Which parts of the drawn map the code has moved out from under, and nothing else. Drawing a repository the first time is expensive; this makes keeping it current cheap — re-read only these components and flows.",
    projectRootArg,
    async ({ projectRoot }) => wrap(async () => mapDrift(await getDb(resolveRoot(projectRoot)))),
  );

  // --- describe_component --------------------------------------------------

  server.tool(
    "describe_component",
    "Draw a box on the map: a named region of the codebase and what it is for. Components nest. Re-using a name updates it rather than adding a second.",
    {
      ...projectRootArg,
      name: z.string().min(1),
      summary: z.string().optional().describe("What it is for, in a sentence a newcomer would understand."),
      kind: z.enum(COMPONENT_KINDS).optional(),
      parent: z
        .string()
        .nullable()
        .optional()
        .describe("Name of the parent component; null moves an existing component to the root."),
      members: z
        .array(z.string())
        .optional()
        .describe("Paths or directory prefixes it covers, e.g. 'src/workflows/lookup/'."),
      acknowledgeUnassigned: z
        .array(z.string())
        .optional()
        .describe("Existing paths deliberately left outside every component."),
      ordinal: z.number().optional().describe("Left-to-right order among its siblings."),
    },
    async ({ projectRoot, ...input }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const result = describeComponent(db, input);
        await db.flush();
        await workspaceChanged(root, "updated");
        return result;
      }),
  );

  // --- describe_flow -------------------------------------------------------

  server.tool(
    "describe_flow",
    "Draw an arrow on the map: a named path through the system, in order, with a note on each step. This is the part that makes a diagram worth reading — what actually happens, start to finish.",
    {
      ...projectRootArg,
      name: z.string().min(1),
      summary: z.string().optional(),
      trigger: z.string().optional().describe("What sets it off — a request, a cron, a message."),
      steps: z
        .array(
          z.object({
            label: z.string().describe("What happens here, in plain words."),
            path: z.string().optional(),
            symbol: z.string().optional(),
            note: z.string().optional().describe("Anything surprising about this step."),
          }),
        )
        .min(1),
    },
    async ({ projectRoot, ...input }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const result = describeFlow(db, input);
        await db.flush();
        await workspaceChanged(root, "updated");
        return result;
      }),
  );

  // --- finalize_map -------------------------------------------------------

  server.tool(
    "finalize_map",
    "Mark the initial authored map complete. Call this only after drawing all components, flows and tags. Every unassigned file must either be mapped or explicitly acknowledged here, so an interrupted first draw remains resumable.",
    {
      ...projectRootArg,
      acknowledgeUnassigned: z
        .array(z.string())
        .optional()
        .describe(
          "Existing paths deliberately left outside every component after the full drawing pass.",
        ),
    },
    async ({ projectRoot, ...input }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const result = finalizeMap(db, input);
        await db.flush();
        await workspaceChanged(root, "updated");
        return result;
      }),
  );

  // --- tag -----------------------------------------------------------------

  server.tool(
    "tag",
    "Label a file or symbol by its nature rather than its location: entrypoint, adapter, model-call, io, config. Components group by where code lives; tags cut across that.",
    {
      ...projectRootArg,
      tag: z.string().min(1),
      path: z.string(),
      symbol: z.string().optional(),
      note: z.string().optional(),
      description: z.string().optional().describe("What this tag means. Set it once."),
    },
    async ({ projectRoot, ...input }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const result = tagNode(db, input);
        await db.flush();
        await workspaceChanged(root, "updated");
        return result;
      }),
  );

  // --- gaps ----------------------------------------------------------------

  server.tool(
    "gaps",
    "What the index cannot explain, ranked: files that register behaviour instead of calling it, exported symbols nothing reaches, imports that resolved to nothing, heavily-used files with nothing recorded about them, and notes written against code that has changed. This is the worklist for making the map real.",
    {
      ...projectRootArg,
      limit: z.number().optional().describe("How many to return. Default 25."),
    },
    async ({ projectRoot, limit }) =>
      wrap(async () => findGaps(await getDb(resolveRoot(projectRoot)), limit)),
  );

  // --- relate --------------------------------------------------------------

  server.tool(
    "relate",
    "Record an edge the parser could not derive — a framework registration, a route, an event handler. Requires the line of code that proves it. Use after reading a file that `gaps` pointed at.",
    {
      ...projectRootArg,
      kind: z.enum(RELATION_KINDS),
      srcPath: z.string().describe("The file that establishes the relation."),
      srcSymbol: z.string().optional(),
      dstPath: z.string().optional().describe("The file on the other end."),
      dstSymbol: z.string().optional(),
      label: z.string().optional().describe("The name the framework knows it by — a node id, a route."),
      evidence: z.string().describe("The line of code that proves this. Required."),
      evidenceLine: z.number().int().min(1).max(4_294_967_295).optional(),
      confidence: z.enum(["definite", "high", "medium", "low"]).optional(),
    },
    async ({ projectRoot, ...input }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const result = relate(db, input);
        await db.flush();
        await workspaceChanged(root, "updated");
        return result;
      }),
  );

  // --- explored ------------------------------------------------------------

  server.tool(
    "explored",
    "Mark a file as examined, with how many relations came out of it. Stops the enrichment loop revisiting the same ground, and expires automatically when the file changes.",
    {
      ...projectRootArg,
      path: z.string(),
      found: z.number().describe("Relations recorded from this file — 0 is a valid, useful answer."),
      note: z.string().optional().describe("What you concluded, especially if nothing was found."),
    },
    async ({ projectRoot, path, found, note }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        markExplored(db, path, found, note);
        await db.flush();
        await workspaceChanged(root, "updated");
        return { path, found };
      }),
  );

  // --- relations -----------------------------------------------------------

  server.tool(
    "relations",
    "Edges recorded by earlier reading, with the evidence for each. Ones whose source file has changed since are flagged.",
    {
      ...projectRootArg,
      path: z.string().optional().describe("Limit to relations touching this file."),
      symbol: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ projectRoot, path, symbol, limit }) =>
      wrap(async () => {
        const db = await getDb(resolveRoot(projectRoot));
        const rows = path ? relationsFor(db, path, symbol) : listRelations(db, limit);
        return { count: rows.length, relations: rows };
      }),
  );

  // --- search_code ---------------------------------------------------------

  server.tool(
    "search_code",
    "Search by code shape rather than text: every empty catch block, every bare except, every throw. Matches the parsed structure, so it distinguishes things a regex cannot. Use a named pattern, or a raw tree-sitter query for anything else.",
    {
      ...projectRootArg,
      pattern: z
        .enum(PATTERNS.map((entry) => entry.name) as [string, ...string[]])
        .optional()
        .describe("A named pattern. Omit to supply your own query."),
      query: z.string().optional().describe("Raw tree-sitter query, e.g. '(throw_statement) @t'."),
      text: z
        .string()
        .optional()
        .describe("Keep only matches whose text contains this — shape plus content."),
      languages: z.array(z.string()).optional(),
      limit: z.number().optional(),
    },
    async ({ projectRoot, pattern, query, text, languages, limit }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        if (!pattern && !query) {
          // Asking with nothing is how a caller discovers what is on offer.
          return {
            patterns: PATTERNS.map((entry) => ({
              name: entry.name,
              description: entry.description,
              why: entry.why,
              languages: entry.languages,
            })),
            note: "Call again with a pattern name, or a raw tree-sitter query.",
          };
        }
        return structuralSearch(root, {
          ...(pattern ? { pattern } : {}),
          ...(query ? { query } : {}),
          ...(text ? { text } : {}),
          ...(languages ? { languages } : {}),
          ...(limit ? { limit } : {}),
        });
      }),
  );

  // --- flow ----------------------------------------------------------------

  server.tool(
    "flow",
    "Evidence-backed execution paths from recognized entries to terminal outcomes and effects. Defaults to the deterministic framework-adapter model when available; use mode 'calls' for the older call-graph orientation view. Returned paths preserve branches, awaits, returns, uncaught throws, provenance, uncertainty, freshness, explicit gaps, and unresolved call targets that keep a path incomplete.",
    {
      ...projectRootArg,
      mode: z
        .enum(["execution", "calls"])
        .optional()
        .describe("Execution paths by default when indexed; 'calls' requests the call graph."),
      entryId: z
        .string()
        .max(512)
        .optional()
        .describe("Exact deterministic entry id returned by an earlier flow query."),
      maxPaths: z.number().int().min(1).max(64).optional(),
      includeAssertions: z
        .boolean()
        .optional()
        .describe(
          "Include current evidence-backed authored relations as a separately labeled overlay. They never complete or alter deterministic paths.",
        ),
      root: z.string().optional().describe("Start from one symbol. Omit for every entry point."),
      rootPath: z.string().optional().describe("Repository path that disambiguates root."),
      rootId: z.string().optional().describe("Exact declaration id returned by a previous flow."),
      depth: z.number().int().min(0).max(8).optional().describe("Layers to follow. Default 3, max 8."),
    },
    async ({
      projectRoot,
      mode,
      entryId,
      maxPaths,
      includeAssertions,
      root,
      rootPath,
      rootId,
      depth,
    }) =>
      wrap(async () => {
        const db = await getDb(resolveRoot(projectRoot));
        const executionIndex = db.executionFlow();
        if (mode === "execution" || entryId || (mode === undefined && executionIndex.entries.length > 0)) {
          const selectedId =
            entryId ?? (executionIndex.entries.length === 1 ? executionIndex.entries[0]?.id : undefined);
          return selectedId
            ? db.executionFlow(selectedId, maxPaths, includeAssertions)
            : executionIndex;
        }
        const view = flowView(db, {
          ...(root ? { root } : {}),
          ...(rootPath ? { rootPath } : {}),
          ...(rootId ? { rootId } : {}),
          ...(depth !== undefined ? { depth } : {}),
        });
        const symbols = new Map(view.nodes.map((node) => [node.id, node.symbol]));
        // The layered ids are for drawing; a caller reading this wants the shape.
        return {
          ...(view.note ? { note: view.note } : {}),
          ...(view.candidates ? { candidates: view.candidates } : {}),
          entries: view.entries,
          layers: view.layers.map((layer, depthIndex) => ({
            depth: depthIndex,
            symbols: layer.map((id) => ({ id, name: symbols.get(id) ?? id })),
          })),
          commons: view.commons.map((id) => ({ id, name: symbols.get(id) ?? id })),
          nodes: view.nodes.length,
          truncated: view.truncated,
        };
      }),
  );

  // --- impact --------------------------------------------------------------

  server.tool(
    "impact",
    "What would need re-checking if this file changed: which of its exports are actually used, by which files, and which tests already cover them. Call before changing a signature.",
    {
      ...projectRootArg,
      target: z.string().describe("File path or a path suffix like 'db.ts'."),
      limit: z.number().optional(),
    },
    async ({ projectRoot, target, limit }) =>
      wrap(async () => impactOf(await getDb(resolveRoot(projectRoot)), target, limit)),
  );

  // --- resolve_types -------------------------------------------------------

  server.tool(
    "resolve_types",
    "Upgrade references from import-resolved to type-resolved using the TypeScript checker. Catches method calls on inferred types and type positions that the fast scan cannot see. Slow — a full type-check — so run it after indexing, not on every change.",
    projectRootArg,
    async ({ projectRoot }, extra) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const result = await resolveTypesInWorker(db, root, extra.signal);
        await db.flush();
        await workspaceChanged(root, "indexed");
        return result;
      }),
  );

  // --- brief ---------------------------------------------------------------

  server.tool(
    "brief",
    "A short, ordered briefing about a file or symbol, ready to hand to a subagent: constraints recorded against it, what it exposes and how widely it is used, what breaks if it changes, which tests cover it, and what is already known to be wrong. Use this instead of dumping files into a subagent's prompt.",
    {
      ...projectRootArg,
      target: z.string().describe("File path, path suffix, or symbol name."),
      task: z
        .string()
        .optional()
        .describe("What the work is — pulls in memories the target alone would miss."),
      budget: z.number().optional().describe("Rough character budget. Default 6000."),
    },
    async ({ projectRoot, target, task, budget }) =>
      wrap(async () => {
        const db = await getDb(resolveRoot(projectRoot));
        return buildBrief(db, target, {
          ...(task ? { task } : {}),
          ...(budget ? { budget } : {}),
        });
      }),
  );

  // --- cross_search --------------------------------------------------------

  server.tool(
    "cross_search",
    "Search every repository this engine indexes at once across paths, symbols, components, flows, findings, relations, and memories; package usage is also available as a focused kind. Use for 'where else do we…' questions.",
    {
      kind: z.enum(CROSS_KINDS),
      query: z.string().trim().min(1).max(512),
      limit: z.number().int().min(1).max(100).optional().describe("Per repository. Default 20."),
    },
    async ({ kind, query, limit }) =>
      wrap(async () => {
        if (!options.listWorkspaces) {
          throw new Error(
            "Cross-repository search needs the running engine. It is unavailable in single-project mode.",
          );
        }
        return crossQuery(await options.listWorkspaces(), kind as CrossKind, query, limit);
      }),
  );

  // --- remember ------------------------------------------------------------

  server.tool(
    "remember",
    "Record something about this codebase that reading the code will not tell you: why a decision was made, a convention to follow, a trap to avoid, or something already tried. Anchor it to the files it applies to.",
    {
      ...projectRootArg,
      kind: z.enum(MEMORY_KINDS),
      title: z.string().min(1).describe("One line. Re-using a title updates that memory."),
      body: z.string().optional().describe("The detail, including why."),
      anchors: z
        .array(
          z.object({
            path: z.string().describe("Repo-relative file path."),
            symbol: z.string().optional(),
          }),
        )
        .optional()
        .describe("Where this applies. Anchored memories resurface via `context`."),
    },
    async ({ projectRoot, kind, title, body, anchors }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const result = remember(db, {
          kind,
          title,
          ...(body !== undefined ? { body } : {}),
          ...(anchors ? { anchors } : {}),
        });
        await db.flush();
        await workspaceChanged(root, "updated");
        return result;
      }),
  );

  // --- recall --------------------------------------------------------------

  server.tool(
    "recall",
    "Search what previous sessions recorded about this codebase. Use before re-deriving why something is the way it is.",
    {
      ...projectRootArg,
      query: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .optional()
        .describe("Keywords. Omit to list the most recent."),
      kind: z.enum(MEMORY_KINDS).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ projectRoot, query, kind, limit }) =>
      wrap(async () => {
        const db = await getDb(resolveRoot(projectRoot));
        const memories = query ? recall(db, query, limit, kind) : listMemories(db, kind, limit);
        const stored = db.count("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'");

        // No matches and an empty store are very different situations, and a
        // bare empty list looks identical for both — so the caller is told
        // which one it is rather than guessing whether to rephrase.
        return {
          count: memories.length,
          totalStored: stored,
          ...(memories.length === 0
            ? {
                note:
                  stored === 0
                    ? "Nothing has been recorded for this repository yet."
                    : `No match. ${stored} memories exist — try broader terms, or omit query to list them.`,
              }
            : {}),
          memories,
        };
      }),
  );

  // --- forget --------------------------------------------------------------

  server.tool(
    "forget",
    "Mark a memory superseded when it is no longer true. It stops surfacing but is kept for history.",
    {
      ...projectRootArg,
      id: z.string(),
      supersededBy: z.string().optional().describe("Id of the memory that replaces it."),
    },
    async ({ projectRoot, id, supersededBy }) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const ok = forget(db, id, supersededBy);
        if (!ok) throw new Error(`No memory with id "${id}".`);
        await db.flush();
        await workspaceChanged(root, "updated");
        return { forgotten: id };
      }),
  );

  // --- audit_review --------------------------------------------------------

  server.tool(
    "audit_review",
    "Run the model review pass in the engine: review each planned unit with a headless coding CLI, then verify every proposed finding against the source before recording it. Costs real tokens on the user's own CLI plan — confirm before calling.",
    {
      ...projectRootArg,
      unitIds: z.array(z.string()).optional().describe("Specific units. Defaults to the whole plan."),
      maxUnits: z.number().int().positive().optional().describe("Cap the number of units reviewed."),
      lens: z.enum(["security", "correctness", "testing", "performance"]).optional(),
      verify: z
        .boolean()
        .optional()
        .describe("Second-pass refutation of each finding. Default true."),
      model: z.string().optional(),
    },
    async ({ projectRoot, unitIds, maxUnits, lens, verify, model }, extra) =>
      wrap(async () => {
        const root = resolveRoot(projectRoot);
        const db = await getDb(root);
        const result = await runReview(db, root, {
          ...(unitIds ? { unitIds } : {}),
          ...(maxUnits !== undefined ? { maxUnits } : {}),
          ...(lens ? { lens } : {}),
          ...(verify !== undefined ? { verify } : {}),
          ...(model ? { model } : {}),
          signal: extra.signal,
        });
        await workspaceChanged(root, "updated");
        return result;
      }),
  );

  return server;
}
