import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { buildContext } from "../plan/context.js";
import { runQuery } from "../plan/query.js";
import { planUnits } from "../plan/risk.js";
import { findRule, guidesForLanguages, loadRules, renderRuleIndex } from "../plan/rules.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

// The shipped guides live at the plugin root, two levels above server/src.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("rule index", () => {
  it("selects guides by language", () => {
    expect(guidesForLanguages(["typescript"]).sort()).toEqual(["general", "typescript"]);
    expect(guidesForLanguages(["python"]).sort()).toEqual(["general", "python"]);
    expect(guidesForLanguages(["javascript"]).sort()).toEqual(["general", "typescript"]);
    expect(guidesForLanguages(["config"])).toEqual(["general"]);
  });

  it("parses the shipped guides into addressable rules", async () => {
    const rules = await loadRules(PLUGIN_ROOT, ["typescript"]);

    expect(rules.length).toBeGreaterThan(5);
    for (const rule of rules) {
      expect(rule.id).toMatch(/^(general|typescript)\/[a-z0-9-]+$/);
      expect(rule.heading.length).toBeGreaterThan(0);
      expect(rule.body.length).toBeGreaterThan(0);
    }
    expect(rules.some((rule) => rule.id === "typescript/type-safety")).toBe(true);
  });

  it("returns full rule text by id, and nothing for an unknown id", async () => {
    const rule = await findRule(PLUGIN_ROOT, "typescript/type-safety");
    expect(rule?.heading).toBe("Type Safety");
    expect(rule?.body.length).toBeGreaterThan(40);

    expect(await findRule(PLUGIN_ROOT, "typescript/does-not-exist")).toBeNull();
  });

  it("renders an index far smaller than the guides it indexes", async () => {
    const rules = await loadRules(PLUGIN_ROOT, ["typescript", "python"]);
    const index = renderRuleIndex(rules);
    const fullText = rules.map((rule) => rule.body).join("\n");

    expect(index.length).toBeLessThan(fullText.length / 3);
    expect(index).toContain("`typescript/type-safety`");
  });
});

describe("rule queries", () => {
  it("lists rules and fetches one through audit_query", async () => {
    root = await makeProject({ "src/a.ts": "export const a = 1;\n" });
    const db = await getDb(root);
    const context = { db, pluginRoot: PLUGIN_ROOT };

    const listed = (await runQuery(context, "rule", undefined)) as Array<{ id: string }>;
    expect(listed.length).toBeGreaterThan(5);

    const fetched = (await runQuery(context, "rule", "typescript/type-safety")) as {
      body: string;
    };
    expect(fetched.body.length).toBeGreaterThan(40);

    const missing = (await runQuery(context, "rule", "nope/nope")) as { error: string };
    expect(missing.error).toMatch(/Unknown rule/);
  });
});

describe("context assembly", () => {
  it("carries the rule index, not the full guide text", async () => {
    root = await makeProject({
      "src/a.ts": "export function a(x: number) { return x; }\n",
      "src/b.ts": "import { a } from './a';\nexport const b = a(1);\n",
    });
    await scan(root, { kind: "full" });

    const db = await getDb(root);
    const unit = planUnits(db, { maxUnits: 1 })[0];
    const context = await buildContext(db, unit, {
      projectRoot: root,
      pluginRoot: PLUGIN_ROOT,
    });

    expect(context.prompt).toContain("REVIEW RULES (index)");
    expect(context.prompt).toContain('`kind: "rule"`');
    expect(context.prompt).toMatch(/- `typescript\/[a-z-]+` — /);

    // The index references rules without inlining their bodies.
    const rule = await findRule(PLUGIN_ROOT, "typescript/type-safety");
    const firstBodyLine = rule!.body.split("\n").find((line) => line.trim().length > 20)!;
    expect(context.prompt).not.toContain(firstBodyLine.trim());
  });
});
