import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { fileView, findingsView, unindexedFindingFileView } from "../daemon/views.js";
import { recordFindings } from "../findings/record.js";
import { sourceContentSha, sourceFreshness } from "../lib/workspace-path.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

let root: string;

afterEach(async () => {
  if (root) await cleanup(root);
});

describe("desktop source navigation views", () => {
  it("keeps symbol and finding ranges with the indexed file signature", async () => {
    root = await makeProject({
      "package.json": "{}",
      "src/navigation.ts": [
        "export function navigate(): string {",
        '  return "ready";',
        "}",
        "",
      ].join("\n"),
    });
    await scan(root, { kind: "desktop-source-navigation" });
    const db = await getDb(root);
    const [findingId] = recordFindings(db, 1, [
      {
        ruleId: "navigation-check",
        category: "correctness",
        severity: "medium",
        confidence: "high",
        source: "llm",
        path: "src/navigation.ts",
        lineStart: 2,
        lineEnd: 3,
        title: "Navigation finding",
        description: "Open the exact source range.",
        snippet: 'return "ready";',
      },
    ]).ids;

    const indexed = fileView(db, "src/navigation.ts");
    expect(indexed).toMatchObject({
      path: "src/navigation.ts",
      contentSha: expect.stringMatching(/^[a-f0-9]{16}$/),
      symbols: [
        expect.objectContaining({
          name: "navigate",
          startLine: 1,
          endLine: 3,
        }),
      ],
      findings: [
        expect.objectContaining({
          id: findingId,
          lineStart: 2,
          lineEnd: 3,
          contentSha: indexed?.contentSha,
        }),
      ],
    });
    expect(findingsView(db).rows[0]).toMatchObject({
      id: findingId,
      lineStart: 2,
      lineEnd: 3,
      contentSha: indexed?.contentSha,
    });

    await writeFile(join(root, "src/navigation.ts"), "export const moved = true;\n");
    await scan(root, { kind: "watch" });
    const rescanned = fileView(db, "src/navigation.ts");
    const historicalFinding = rescanned?.findings.find((finding) => finding.id === findingId);
    expect(rescanned?.contentSha).not.toBe(indexed?.contentSha);
    expect(historicalFinding?.contentSha).toBe(indexed?.contentSha);
    expect(
      sourceFreshness(
        rescanned?.contentSha ?? "",
        rescanned?.contentSha ?? "",
        historicalFinding?.contentSha,
      ),
    ).toBe("stale");
  });

  it("allows finding evidence to open readable source excluded from the inventory", async () => {
    const settings = '{"permissions":{"allow":["Bash(*)"]}}\n';
    root = await makeProject({
      "package.json": "{}",
      ".claude/settings.json": settings,
      ".env": "TOKEN=secret\n",
    });
    await scan(root, { kind: "desktop-hidden-finding-source" });
    const db = await getDb(root);
    recordFindings(db, 1, [
      {
        ruleId: "agent-config/wildcard-bash",
        category: "security",
        severity: "high",
        confidence: "definite",
        source: "linter",
        path: ".claude/settings.json",
        lineStart: 1,
        evidenceSha: sourceContentSha(settings),
        title: "Wildcard shell permission",
      },
    ]);

    expect(fileView(db, ".claude/settings.json")).toBeNull();
    expect(
      unindexedFindingFileView(db, ".claude/settings.json", {
        lang: "config",
        loc: 2,
        contentSha: sourceContentSha(settings),
      }),
    ).toMatchObject({
      indexed: false,
      path: ".claude/settings.json",
      lang: "config",
      findings: [expect.objectContaining({ ruleId: "agent-config/wildcard-bash" })],
    });
    expect(
      unindexedFindingFileView(db, ".env", {
        lang: "other",
        loc: 2,
        contentSha: sourceContentSha("TOKEN=secret\n"),
      }),
    ).toBeNull();
  });

  it("resolves an authored symbol against all declarations, not the drawer truncation", async () => {
    const declarations = [
      "export function duplicate() { return 0; }",
      ...Array.from(
        { length: 200 },
        (_, index) => `export function filler${index}() { return ${index}; }`,
      ),
      "export function duplicate() { return 1; }",
      "export function beyondDrawerLimit() { return true; }",
    ];
    root = await makeProject({
      "package.json": "{}",
      "src/many.ts": declarations.join("\n"),
    });
    await scan(root, { kind: "desktop-exact-symbol-navigation" });
    const db = await getDb(root);

    const exact = fileView(db, "src/many.ts", "beyondDrawerLimit");
    expect(exact?.symbols).toHaveLength(200);
    expect(exact?.symbols.some((symbol) => symbol.name === "beyondDrawerLimit")).toBe(false);
    expect(exact).toMatchObject({
      symbolsTotal: 203,
      symbolMatchTotal: 1,
      symbolMatches: [
        expect.objectContaining({
          name: "beyondDrawerLimit",
          startLine: 203,
        }),
      ],
    });

    const ambiguous = fileView(db, "src/many.ts", "duplicate");
    expect(ambiguous?.symbolMatchTotal).toBe(2);
    expect(ambiguous?.symbolMatches.map((symbol) => symbol.startLine)).toEqual([1, 202]);
  });
});
