#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getStatus } from "./tools/get-status.js";
import { discover } from "./tools/discover.js";
import { runTools } from "./tools/run-tools.js";
import { planAnalysis } from "./tools/plan-analysis.js";
import { getModuleContext } from "./tools/get-module-context.js";
import { validateModules } from "./tools/validate-modules.js";
import { buildGraphs } from "./tools/build-graphs.js";
import { planSpecialists } from "./tools/plan-specialists.js";
import { getSpecialistContext } from "./tools/get-specialist-context.js";
import { assembleOutputs } from "./tools/assemble-outputs.js";

const PLUGIN_ROOT = process.env.PLUGIN_ROOT ?? process.cwd();

const server = new McpServer({
  name: "repo-audit",
  version: "3.0.0",
});

// --- audit_get_status ---
server.tool(
  "audit_get_status",
  "Return current audit state. Useful for resuming after a session drop or for progress reporting.",
  {
    projectRoot: z
      .string()
      .optional()
      .describe("Project root directory. Default: cwd."),
  },
  async ({ projectRoot }) => {
    const root = projectRoot ?? process.cwd();
    const result = await getStatus(root, PLUGIN_ROOT);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- audit_discover ---
server.tool(
  "audit_discover",
  "Run Phase 0 (discovery) and Phase 0.5 prerequisites check. Scans directory structure, detects languages/frameworks, checks tool availability, and writes detection.json.",
  {
    projectRoot: z
      .string()
      .optional()
      .describe("Project root directory. Default: cwd."),
    force: z
      .boolean()
      .optional()
      .describe("Ignore cached detection.json and re-run discovery. Default: false."),
  },
  async ({ projectRoot, force }) => {
    try {
      const result = await discover(
        { projectRoot, force: force ?? undefined },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- audit_run_tools ---
server.tool(
  "audit_run_tools",
  "Run Phase 0.5 (pre-analysis) — linters, type checkers, dependency audits, code metrics, git analysis, pattern pre-scans, skeleton extraction. Requires audit_discover to have been called first.",
  {
    tools: z
      .array(z.string())
      .optional()
      .describe("Specific tools to run. Default: all detected."),
    skipIfCached: z
      .boolean()
      .optional()
      .describe(
        "Skip if tool-output/ already has results. Default: true.",
      ),
  },
  async ({ tools, skipIfCached }) => {
    try {
      const result = await runTools(
        { tools: tools ?? undefined, skipIfCached: skipIfCached ?? undefined },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- audit_plan_analysis ---
server.tool(
  "audit_plan_analysis",
  "Plan module assignments for deep analysis. Reads detection.json, applies batching rules, assigns directories to agents, writes assignment-plan.json. Requires audit_discover + audit_run_tools.",
  {
    maxAgents: z
      .number()
      .optional()
      .describe("Maximum number of parallel analysis agents. Default: 20 (30 for monorepos)."),
    tokenBudget: z
      .number()
      .optional()
      .describe("Per-agent token budget. Default: 80000."),
    incrementalModules: z
      .array(z.string())
      .optional()
      .describe("Only re-analyze these directories. Others reuse existing module JSONs."),
  },
  async ({ maxAgents, tokenBudget, incrementalModules }) => {
    try {
      const result = await planAnalysis(
        {
          maxAgents: maxAgents ?? undefined,
          tokenBudget: tokenBudget ?? undefined,
          incrementalModules: incrementalModules ?? undefined,
        },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- audit_get_module_context ---
server.tool(
  "audit_get_module_context",
  "Assemble the complete context prompt for a module analysis sub-agent. Includes language guides, skeletons, prescan/linter data, and source files within token budget. Requires audit_plan_analysis.",
  {
    assignmentId: z
      .string()
      .describe("Assignment ID from plan_analysis (e.g. 'module-01')."),
    tokenBudget: z
      .number()
      .optional()
      .describe("Token budget for this context. Default: 80000."),
  },
  async ({ assignmentId, tokenBudget }) => {
    try {
      const result = await getModuleContext(
        {
          assignmentId,
          tokenBudget: tokenBudget ?? undefined,
        },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- audit_validate_modules ---
server.tool(
  "audit_validate_modules",
  "Validate all module JSON files against the schema. Runs validate-module-json.sh, reads validation results, updates state with passed/failed modules.",
  {
    modules: z
      .array(z.string())
      .optional()
      .describe("Specific module IDs to check. Default: all in sdlc-audit/modules/."),
  },
  async ({ modules }) => {
    try {
      const result = await validateModules(
        { modules: modules ?? undefined },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- audit_build_graphs ---
server.tool(
  "audit_build_graphs",
  "Run all programmatic cross-module analysis: dependency graph, risk scores, variant analysis. Returns cross-module agent prompts for LLM judgment work. Requires module JSONs in sdlc-audit/modules/.",
  {
    includeVariantAnalysis: z
      .boolean()
      .optional()
      .describe("Run variant analysis (grep-based pattern search for recurring issues). Default: true."),
  },
  async ({ includeVariantAnalysis }) => {
    try {
      const result = await buildGraphs(
        { includeVariantAnalysis: includeVariantAnalysis ?? undefined },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- audit_plan_specialists ---
server.tool(
  "audit_plan_specialists",
  "Read all module JSONs, aggregate specialist_triage fields, determine which specialist agents to run based on thresholds. Writes specialist-plan.json.",
  {
    forceAll: z
      .boolean()
      .optional()
      .describe("Run all specialists regardless of triage thresholds. Default: false."),
  },
  async ({ forceAll }) => {
    try {
      const result = await planSpecialists(
        { forceAll: forceAll ?? undefined },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- audit_get_specialist_context ---
server.tool(
  "audit_get_specialist_context",
  "Assemble the complete context prompt for a specialist Task agent. Includes agent prompt, flagged files, triage notes, relevant guide sections, and output schema. Requires audit_plan_specialists.",
  {
    domain: z
      .string()
      .describe("Specialist domain from plan_specialists (e.g. 'error_handling', 'security')."),
    tokenBudget: z
      .number()
      .optional()
      .describe("Token budget for this context. Default: 100000."),
  },
  async ({ domain, tokenBudget }) => {
    try {
      const result = await getSpecialistContext(
        {
          domain,
          tokenBudget: tokenBudget ?? undefined,
        },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- audit_assemble_outputs ---
server.tool(
  "audit_assemble_outputs",
  "Generate final reports (AUDIT_REPORT.md, PROJECT_MAP.md, TECH_DEBT.md, etc.), TASKS.json, and audit metadata. Optionally returns synthesis prompts for PATTERNS.md and CLAUDE.md.",
  {
    auditType: z
      .enum(["full", "incremental", "quick", "security", "deps", "arch", "patterns", "coverage"])
      .describe("Type of audit that was run."),
    synthesisNeeded: z
      .boolean()
      .optional()
      .describe("Return prompts for LLM synthesis of PATTERNS.md and CLAUDE.md. Default: true."),
  },
  async ({ auditType, synthesisNeeded }) => {
    try {
      const result = await assembleOutputs(
        {
          auditType,
          synthesisNeeded: synthesisNeeded ?? undefined,
        },
        PLUGIN_ROOT,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: true,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Startup ---
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
