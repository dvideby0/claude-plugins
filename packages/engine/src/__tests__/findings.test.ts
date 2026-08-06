import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { closeStale, recordFindings, suppress } from "../findings/record.js";
import { fingerprint } from "../findings/fingerprint.js";
import { findCycles } from "../analyze/graph.js";
import { scanSecrets } from "../analyze/secrets.js";
import type { FindingInput } from "../findings/types.js";
import type { ScannedFile } from "../scan/walk.js";
import { cleanup, makeProject } from "./helpers.js";

function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    ruleId: "eslint/no-eval",
    category: "security",
    severity: "high",
    confidence: "definite",
    source: "linter",
    title: "no-eval: eval is evil",
    path: "src/a.ts",
    lineStart: 10,
    lineEnd: 10,
    snippet: "eval(userInput)",
    ...overrides,
  };
}

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("fingerprint", () => {
  it("is stable when the finding moves down the file", () => {
    expect(fingerprint(finding({ lineStart: 10 }))).toBe(
      fingerprint(finding({ lineStart: 340 })),
    );
  });

  it("ignores whitespace and literal numbers in the snippet", () => {
    expect(fingerprint(finding({ snippet: "eval( userInput )" }))).toBe(
      fingerprint(finding({ snippet: "eval(userInput)" })),
    );
  });

  it("differs across rules, files and code shape", () => {
    const base = fingerprint(finding());
    expect(fingerprint(finding({ ruleId: "eslint/no-new-func" }))).not.toBe(base);
    expect(fingerprint(finding({ path: "src/b.ts" }))).not.toBe(base);
    expect(fingerprint(finding({ snippet: "exec(userInput)" }))).not.toBe(base);
  });
});

describe("finding lifecycle", () => {
  it("creates once and updates thereafter", async () => {
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    expect(recordFindings(db, 1, [finding()]).created).toBe(1);

    const second = recordFindings(db, 2, [finding({ lineStart: 42 })]);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    expect(db.count("SELECT COUNT(*) AS n FROM findings")).toBe(1);
    expect(
      db.get<{ line_start: number; occurrences: number }>(
        "SELECT line_start, occurrences FROM findings",
      ),
    ).toEqual({ line_start: 42, occurrences: 2 });
  });

  it("closes findings a tool stopped reporting, and reopens them as regressed", async () => {
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    recordFindings(db, 1, [finding()]);
    expect(closeStale(db, 2, "eslint/")).toBe(1);
    expect(db.get<{ status: string }>("SELECT status FROM findings")?.status).toBe("fixed");

    const reopened = recordFindings(db, 3, [finding()]);
    expect(reopened.reopened).toBe(1);
    expect(db.get<{ status: string }>("SELECT status FROM findings")?.status).toBe("regressed");
  });

  it("never closes findings belonging to another tool", async () => {
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    recordFindings(db, 1, [finding(), finding({ ruleId: "ruff/S101", source: "linter" })]);
    closeStale(db, 2, "eslint/");

    expect(
      db.get<{ status: string }>("SELECT status FROM findings WHERE rule_id = 'ruff/S101'")?.status,
    ).toBe("open");
  });

  it("keeps human decisions sticky across runs", async () => {
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    recordFindings(db, 1, [finding()]);
    const id = db.get<{ id: string }>("SELECT id FROM findings")!.id;
    suppress(db, { findingId: id, reason: "intentional in sandbox" });

    recordFindings(db, 2, [finding()]);
    expect(db.get<{ status: string }>("SELECT status FROM findings")?.status).toBe(
      "false_positive",
    );
  });

  it("keeps accepted risks distinct from false positives", async () => {
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    recordFindings(db, 1, [finding()]);
    const id = db.get<{ id: string }>("SELECT id FROM findings")!.id;
    suppress(db, {
      findingId: id,
      reason: "required for legacy compatibility",
      disposition: "accepted",
    });

    recordFindings(db, 2, [finding()]);
    expect(db.get<{ status: string }>("SELECT status FROM findings")?.status).toBe(
      "accepted",
    );
  });

  it("suppresses a rule under a path prefix before it is ever stored", async () => {
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    suppress(db, { ruleId: "eslint/no-eval", pathPrefix: "src/", reason: "legacy area" });
    const result = recordFindings(db, 1, [finding()]);

    expect(result.suppressed).toBe(1);
    expect(db.count("SELECT COUNT(*) AS n FROM findings")).toBe(0);
  });
});

describe("secret scanning", () => {
  const file = (content: string, path = "src/config.ts"): ScannedFile => ({
    path,
    lang: "typescript",
    loc: content.split("\n").length,
    bytes: content.length,
    contentSha: "x",
    isTest: path.includes("test"),
    content,
  });

  it("flags real-looking secrets", () => {
    const findings = scanSecrets([
      file('const key = "AKIA2E0CQZ7XKL39MTUV";'),
      file("const db = \"postgres://admin:s3cr3tpw@db.internal:5432/app\";", "src/db.ts"),
    ]);
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "secrets/aws-access-key",
      "secrets/connection-string-password",
    ]);
  });

  it("ignores placeholders and env lookups", () => {
    const findings = scanSecrets([
      file('const password = process.env.DB_PASSWORD;'),
      file('const apiKey = "your-api-key-here";'),
      file('token = "<REPLACE_ME>"'),
    ]);
    expect(findings).toEqual([]);
  });

  it("downgrades severity inside tests", () => {
    const findings = scanSecrets([
      file('const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";', "src/a.test.ts"),
    ]);
    expect(findings[0].severity).toBe("medium");
  });

  it("scans credentials on long one-line configuration", () => {
    const padding = "x".repeat(800);
    const findings = scanSecrets([
      file(`{"padding":"${padding}","token":"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}`),
    ]);
    expect(findings.map((finding) => finding.ruleId)).toContain("secrets/github-token");
  });
});

describe("graph analysis", () => {
  it("finds import cycles and ignores acyclic graphs", () => {
    expect(
      findCycles([
        { src: "a.ts", dst: "b.ts" },
        { src: "b.ts", dst: "c.ts" },
        { src: "c.ts", dst: "a.ts" },
        { src: "d.ts", dst: "a.ts" },
      ]),
    ).toEqual([["a.ts", "b.ts", "c.ts"]]);

    expect(findCycles([{ src: "a.ts", dst: "b.ts" }])).toEqual([]);
  });
});
