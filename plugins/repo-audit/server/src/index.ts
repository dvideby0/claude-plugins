#!/usr/bin/env node

/**
 * repo-audit MCP server.
 *
 * All state lives in sdlc-audit/audit.db, so every tool is independently
 * callable and a restarted server resumes exactly where it left off.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runAnalyzers } from "./analyze/run.js";
import { getDb } from "./db/db.js";
import { extractSnippet } from "./findings/fingerprint.js";
import { recordFindings, suppress } from "./findings/record.js";
import { CATEGORIES, CONFIDENCES, SEVERITIES, type FindingInput } from "./findings/types.js";
import { buildContext } from "./plan/context.js";
import { QUERY_KINDS, runQuery, type QueryKind } from "./plan/query.js";
import { loadPlan, planUnits, savePlan } from "./plan/risk.js";
import { exportReports } from "./report/export.js";
import { scan } from "./scan/scan.js";

const PLUGIN_ROOT = process.env.PLUGIN_ROOT ?? process.cwd();

function resolveRoot(projectRoot?: string): string {
  return projectRoot ?? process.env.AUDIT_PROJECT_ROOT ?? process.cwd();
}

const server = new McpServer({ name: "repo-audit", version: "4.0.0" });

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
  projectRoot: z.string().optional().describe("Project root. Defaults to the server's cwd."),
};

// --- audit_status ----------------------------------------------------------

server.tool(
  "audit_status",
  "Report what the audit store already knows: last run, indexed files, open findings, and the next step.",
  projectRootArg,
  async ({ projectRoot }) =>
    wrap(async () => {
      const root = resolveRoot(projectRoot);
      const db = await getDb(root);

      const files = db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1");
      const lastRun = db.get<{ id: number; kind: string; started_at: string; git_sha: string | null }>(
        "SELECT id, kind, started_at, git_sha FROM runs ORDER BY id DESC LIMIT 1",
      );
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
              : "audit_export";

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

// --- audit_scan ------------------------------------------------------------

server.tool(
  "audit_scan",
  "Index the repository: walk files, extract symbols and imports with tree-sitter, resolve the dependency graph. Incremental — unchanged files are skipped.",
  {
    ...projectRootArg,
    full: z.boolean().optional().describe("Re-parse every file, ignoring content hashes."),
  },
  async ({ projectRoot, full }) =>
    wrap(() => scan(resolveRoot(projectRoot), { full, kind: full ? "full" : "incremental" })),
);

// --- audit_run_tools -------------------------------------------------------

server.tool(
  "audit_run_tools",
  "Run deterministic analysis: the project's own linters and type checkers, secret scanning, dependency advisories, and import-cycle detection. Records findings.",
  {
    ...projectRootArg,
    offline: z.boolean().optional().describe("Skip the OSV advisory lookup."),
  },
  async ({ projectRoot, offline }) =>
    wrap(() => runAnalyzers(resolveRoot(projectRoot), { offline })),
);

// --- audit_plan ------------------------------------------------------------

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
      const db = await getDb(resolveRoot(projectRoot));
      const units = planUnits(db, { tokenBudget, maxUnits });
      savePlan(db, units);
      await db.flush();
      return { units, totalUnits: units.length };
    }),
);

// --- audit_context ---------------------------------------------------------

server.tool(
  "audit_context",
  "Build the review prompt for one unit: rules, findings already known, graph neighbourhood, and source packed to budget.",
  {
    ...projectRootArg,
    unitId: z.string().describe("Unit id from audit_plan, e.g. 'unit-01'."),
    tokenBudget: z.number().optional().describe("Context budget. Default 60000."),
  },
  async ({ projectRoot, unitId, tokenBudget }) =>
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
      return buildContext(db, unit, { projectRoot: root, pluginRoot: PLUGIN_ROOT, tokenBudget });
    }),
);

// --- audit_record_findings -------------------------------------------------

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

      // Snippets come from the file itself, not from the agent.
      const enriched: FindingInput[] = [];
      for (const finding of findings) {
        let snippet: string | undefined;
        if (finding.path && finding.lineStart) {
          try {
            const content = await readFile(join(root, finding.path), "utf-8");
            snippet = extractSnippet(content, finding.lineStart, finding.lineEnd);
          } catch {
            // File unreadable — fingerprint falls back to the title.
          }
        }
        enriched.push({ ...finding, source: "llm", snippet });
      }

      const summary = recordFindings(db, runId, enriched);
      await db.flush();
      return summary;
    }),
);

// --- audit_query -----------------------------------------------------------

server.tool(
  "audit_query",
  "Query the audit store: symbol definitions, importers, imports, findings, hotspots, external packages, cycles.",
  {
    ...projectRootArg,
    kind: z.enum(QUERY_KINDS),
    arg: z.string().optional().describe("Symbol name, file path, or filter value."),
    limit: z.number().optional(),
  },
  async ({ projectRoot, kind, arg, limit }) =>
    wrap(async () => {
      const db = await getDb(resolveRoot(projectRoot));
      return { kind, rows: runQuery(db, kind as QueryKind, arg, limit) };
    }),
);

// --- audit_suppress --------------------------------------------------------

server.tool(
  "audit_suppress",
  "Mark a finding accepted or a false positive, or silence a rule under a path. Suppressions persist across runs.",
  {
    ...projectRootArg,
    findingId: z.string().optional().describe("Suppress this exact finding."),
    ruleId: z.string().optional().describe("Suppress a rule, optionally scoped by pathPrefix."),
    pathPrefix: z.string().optional(),
    reason: z.string().min(1),
  },
  async ({ projectRoot, findingId, ruleId, pathPrefix, reason }) =>
    wrap(async () => {
      if (!findingId && !ruleId) throw new Error("Provide findingId or ruleId.");
      const db = await getDb(resolveRoot(projectRoot));
      suppress(db, { findingId, ruleId, pathPrefix, reason });
      await db.flush();
      return { suppressed: findingId ?? `${ruleId}${pathPrefix ? ` under ${pathPrefix}` : ""}` };
    }),
);

// --- audit_export ----------------------------------------------------------

server.tool(
  "audit_export",
  "Write reports/AUDIT.md, reports/MAP.md and TASKS.json from the store. Safe to run repeatedly.",
  projectRootArg,
  async ({ projectRoot }) =>
    wrap(async () => {
      const root = resolveRoot(projectRoot);
      return exportReports(await getDb(root), root);
    }),
);

// --- startup ---------------------------------------------------------------

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("repo-audit server failed to start:", error);
  process.exit(1);
});
