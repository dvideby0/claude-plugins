import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { closeStale, recordFindings, suppress } from "../findings/record.js";
import { fingerprint } from "../findings/fingerprint.js";
import { findCycles } from "../analyze/graph.js";
import { scanSecrets } from "../analyze/secrets.js";
import type { FindingInput } from "../findings/types.js";
import type { SourceTextFile } from "../scan/source.js";
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

describe("findings follow a file that moves", () => {
  /** What the scan records when it confirms a rename. */
  function recordMove(db: Awaited<ReturnType<typeof getDb>>, from: string, to: string, run: number) {
    db.run(
      `INSERT OR REPLACE INTO file_moves(run_id, from_path, to_path, evidence, moved_at)
       VALUES(?, ?, ?, 'git-rename', ?)`,
      [run, from, to, new Date().toISOString()],
    );
    db.run("UPDATE findings SET path = ? WHERE path = ?", [to, from]);
  }

  it("keeps a human decision across renames the analyzer never saw", async () => {
    // Scans are watch-triggered per edit; analyzers run on demand. So a file
    // can move twice before anything re-examines it, and the stored row still
    // carries the id fingerprinted over its original path.
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    const id = fingerprint(finding());
    expect(recordFindings(db, 1, [finding()]).created).toBe(1);
    suppress(db, { findingId: id, reason: "reviewed and accepted", disposition: "accepted" });

    recordMove(db, "src/a.ts", "src/b.ts", 2);
    recordMove(db, "src/b.ts", "src/c.ts", 3);

    const result = recordFindings(db, 4, [finding({ path: "src/c.ts" })]);
    // Adopted, not re-created: a duplicate here would let closeStale close the
    // original as fixed on a run that never examined it. It reports as
    // suppressed because the decision it carried across still applies.
    expect(result.created).toBe(0);
    expect(result.suppressed).toBe(1);
    expect(db.count("SELECT COUNT(*) AS n FROM findings")).toBe(1);

    const moved = db.get<{ path: string; status: string }>("SELECT path, status FROM findings");
    expect(moved?.path).toBe("src/c.ts");
    // The decision somebody made about this problem survives the move.
    expect(moved?.status).toBe("accepted");
    expect(
      db.count("SELECT COUNT(*) AS n FROM suppressions WHERE finding_id = ?", [
        fingerprint(finding({ path: "src/c.ts" })),
      ]),
    ).toBe(1);
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

  it("does not re-close a retired finding as fixed", async () => {
    // Retired already means closed, and closed for a reason that is not
    // "somebody fixed it". A later tool run must not launder it into one.
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    recordFindings(db, 1, [finding()]);
    db.run("UPDATE findings SET status = 'retired'");

    expect(closeStale(db, 2, "eslint/")).toBe(0);
    expect(db.get<{ status: string }>("SELECT status FROM findings")?.status).toBe("retired");
  });

  it("reopens a retired finding as open, never as regressed", async () => {
    // Regressed says it was fixed and came back. Nothing fixed this one.
    root = await makeProject({ "a.ts": "" });
    const db = await getDb(root);

    recordFindings(db, 1, [finding()]);
    db.run("UPDATE findings SET status = 'retired'");

    const seen = recordFindings(db, 2, [finding()]);
    expect(seen.reopened).toBe(0);
    expect(db.get<{ status: string }>("SELECT status FROM findings")?.status).toBe("open");
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
  const file = (content: string, path = "src/config.ts"): SourceTextFile => ({
    path,
    lang: "typescript",
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
