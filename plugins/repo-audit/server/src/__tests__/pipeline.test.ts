import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAnalyzers } from "../analyze/run.js";
import { getDb } from "../db/db.js";
import { recordFindings } from "../findings/record.js";
import { buildContext } from "../plan/context.js";
import { runQuery } from "../plan/query.js";
import { loadPlan, planUnits, savePlan } from "../plan/risk.js";
import { exportReports } from "../report/export.js";
import { scan } from "../scan/scan.js";
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
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("pipeline", () => {
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

    const exported = await exportReports(db, root);
    expect(exported.reports).toContain("TASKS.json");
    expect(exported.openFindings).toBeGreaterThan(0);

    const audit = await readFile(join(root, "sdlc-audit", "reports", "AUDIT.md"), "utf-8");
    expect(audit).toContain("String-concatenated SQL");

    const tasks = JSON.parse(await readFile(join(root, "sdlc-audit", "TASKS.json"), "utf-8"));
    expect(tasks.tasks.length).toBeGreaterThan(0);
    expect(tasks.tasks[0].severity).toBe("critical");

    const map = await readFile(join(root, "sdlc-audit", "reports", "MAP.md"), "utf-8");
    expect(map).toContain("src/core/db.ts");
  });

  it("answers graph queries", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const importers = runQuery(db, "importers", "src/core/db.ts") as Array<{ importer: string }>;
    expect(importers.map((row) => row.importer).sort()).toEqual([
      "src/api/orders.ts",
      "src/api/users.ts",
      "src/core/db.test.ts",
    ]);

    const symbols = runQuery(db, "symbol", "getUser") as Array<{ path: string }>;
    expect(symbols[0].path).toBe("src/api/users.ts");

    const hotspots = runQuery(db, "hotspots", undefined, 3) as Array<{ path: string; fan_in: number }>;
    expect(hotspots[0].path).toBe("src/core/db.ts");
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
});
