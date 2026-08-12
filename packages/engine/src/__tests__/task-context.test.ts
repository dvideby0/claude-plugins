import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Buffer } from "node:buffer";
import { appendFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { resolveTypes } from "../graph/typed.js";
import { exec } from "../lib/exec.js";
import { isolatedFixtureGitEnvironment } from "../lib/git-environment.js";
import { remember } from "../memory/store.js";
import { createMcpServer } from "../mcp/server.js";
import { buildTaskContext } from "../plan/task-context.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

async function runGit(project: string, args: string[]): Promise<void> {
  const result = await exec("git", args, {
    cwd: project,
    timeout: 20_000,
    maxBuffer: 1_000_000,
    env: isolatedFixtureGitEnvironment(project),
  });
  if (result.exitCode !== 0 || result.spawnFailed || result.timedOut || result.truncated) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

async function initializeGit(project: string): Promise<void> {
  await runGit(project, ["init", "--quiet", "--template="]);
  await runGit(project, ["add", "."]);
  await runGit(project, [
    "-c",
    "user.name=SDLC Test",
    "-c",
    "user.email=sdlc-test@example.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "baseline",
  ]);
}

describe("budgeted task context", () => {
  it("uses Git working-tree changes as ranked graph seeds without a task keyword", async () => {
    root = await makeProject({
      "src/checkout.ts": [
        "import { reserveInventory } from './inventory.js';",
        "export async function checkout() { return reserveInventory(); }",
        "",
      ].join("\n"),
      "src/inventory.ts": "export function reserveInventory() { return 'reserved'; }\n",
      "src/profile.ts": "export function loadProfile() { return 'profile'; }\n",
    });
    await initializeGit(root);
    await writeFile(
      join(root, "src/inventory.ts"),
      "export function reserveInventory() { return 'reserved-with-stock-check'; }\n",
    );
    await scan(root, { kind: "change-relevance-test" });

    const brief = await buildTaskContext(await getDb(root), root, {
      task: "review the current working tree change",
      intent: "review",
      budgetBytes: 20_000,
    });

    expect(brief.changeContext).not.toBe("clean");
    if (typeof brief.changeContext === "string") throw new Error("Expected a detected change.");
    expect(brief.changeContext).toMatchObject({
      state: "available",
      detectedPaths: 1,
      changes: [{ path: "src/inventory.ts", status: "modified" }],
    });
    expect(brief.changeContext.omittedPaths ?? 0).toBe(0);
    expect(brief.readFirst[0]).toBe("src/inventory.ts");
    expect(
      brief.evidence.some(
        (item) =>
          item.source?.path === "src/inventory.ts" &&
          item.reasons.some((reason) => reason.includes("changed")),
      ),
    ).toBe(true);
    expect(brief.evidence.some((item) => item.source?.path === "src/checkout.ts")).toBe(true);
    expect(brief.evidence.some((item) => item.source?.path === "src/profile.ts")).toBe(false);
  });

  it("keeps an explicit target ahead of unrelated dirty files at the minimum budget", async () => {
    root = await makeProject({
      "src/target.ts": "export const requestedTarget = true;\n",
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
      "src/c.ts": "export const c = 1;\n",
    });
    await initializeGit(root);
    await scan(root, { kind: "explicit-target-baseline" });
    await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
    await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
    await writeFile(join(root, "src/c.ts"), "export const c = 2;\n");
    await scan(root, { kind: "explicit-target-dirty" });

    const brief = await buildTaskContext(await getDb(root), root, {
      targets: ["src/target.ts"],
      intent: "understand",
      budgetBytes: 6_000,
      isolatedGitConfig: true,
    });

    expect(brief.targets[0]).toMatchObject({ status: "resolved", path: "src/target.ts" });
    expect(brief.evidence[0]?.source?.path).toBe("src/target.ts");
    expect(brief.readFirst).toContain("src/target.ts");
  });

  it("keeps a strong task match ahead of unrelated dirty files at the minimum budget", async () => {
    const files: Record<string, string> = {
      "src/checkout.ts": "export function checkoutInventory() { return 'ok'; }\n",
    };
    for (let index = 0; index < 5; index += 1) {
      files[`src/unrelated${index}.ts`] = `export const unrelated${index} = 1;\n`;
    }
    root = await makeProject(files);
    await initializeGit(root);
    await scan(root, { kind: "task-match-baseline" });
    for (let index = 0; index < 5; index += 1) {
      await writeFile(
        join(root, `src/unrelated${index}.ts`),
        `export const unrelated${index} = 2;\n`,
      );
    }
    await scan(root, { kind: "task-match-dirty" });

    const brief = await buildTaskContext(await getDb(root), root, {
      task: "understand checkout inventory",
      intent: "understand",
      budgetBytes: 6_000,
      isolatedGitConfig: true,
    });

    expect(brief.evidence.some((item) => item.source?.path === "src/checkout.ts")).toBe(true);
    expect(brief.readFirst).toContain("src/checkout.ts");
  });

  it("marks a deletion historical before the watcher refreshes the index", async () => {
    root = await makeProject({
      "src/checkout.ts": "import { reserve } from './inventory.js';\nexport const checkout = reserve;\n",
      "src/inventory.ts": "export function reserve() { return true; }\n",
    });
    await initializeGit(root);
    await scan(root, { kind: "pre-refresh-deletion-baseline" });
    await unlink(join(root, "src/inventory.ts"));

    const brief = await buildTaskContext(await getDb(root), root, {
      task: "review the current working tree change",
      intent: "review",
      budgetBytes: 20_000,
      isolatedGitConfig: true,
    });

    expect(brief.changeContext).not.toBe("clean");
    if (typeof brief.changeContext === "string") throw new Error("Expected a deletion.");
    expect(brief.changeContext.changes).toContainEqual(
      expect.objectContaining({
        path: "src/inventory.ts",
        status: "deleted",
        indexState: "historical",
      }),
    );
    const inventoryEvidence = brief.evidence.filter(
      (item) => item.source?.path === "src/inventory.ts",
    );
    expect(inventoryEvidence.some((item) => item.kind === "change")).toBe(true);
    expect(inventoryEvidence.every((item) => item.provenance.freshness === "stale")).toBe(true);
  });

  it("treats a staged deletion recreated as an untracked file as current after scanning", async () => {
    root = await makeProject({
      "src/inventory.ts": "export const inventory = 1;\n",
    });
    await initializeGit(root);
    await scan(root, { kind: "recreated-file-baseline" });
    await runGit(root, ["rm", "--quiet", "src/inventory.ts"]);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/inventory.ts"), "export const inventory = 2;\n");
    await scan(root, { kind: "recreated-file-current" });

    const brief = await buildTaskContext(await getDb(root), root, {
      task: "review the current working tree change",
      intent: "review",
      budgetBytes: 12_000,
      isolatedGitConfig: true,
    });

    expect(brief.changeContext).not.toBe("clean");
    if (typeof brief.changeContext === "string") throw new Error("Expected a recreated file.");
    expect(brief.changeContext.changes).toContainEqual(
      expect.objectContaining({
        path: "src/inventory.ts",
        status: "staged-deleted + untracked",
        indexState: "current",
      }),
    );
    const inventoryEvidence = brief.evidence.filter(
      (item) => item.source?.path === "src/inventory.ts",
    );
    expect(inventoryEvidence.length).toBeGreaterThan(0);
    expect(inventoryEvidence.every((item) => item.provenance.freshness === "current")).toBe(true);
  });

  it("keeps an ignored file live when it is removed only from the Git index", async () => {
    root = await makeProject({
      "src/inventory.ts": "export const inventory = 1;\n",
    });
    await initializeGit(root);
    await scan(root, { kind: "cached-removal-baseline" });
    await writeFile(join(root, ".gitignore"), "src/inventory.ts\n");
    await runGit(root, ["add", ".gitignore"]);
    await runGit(root, ["rm", "--cached", "--quiet", "src/inventory.ts"]);

    const brief = await buildTaskContext(await getDb(root), root, {
      task: "review the current working tree change",
      intent: "review",
      budgetBytes: 12_000,
      isolatedGitConfig: true,
    });

    expect(brief.changeContext).not.toBe("clean");
    if (typeof brief.changeContext === "string") throw new Error("Expected a cached removal.");
    expect(brief.changeContext.changes).toContainEqual(
      expect.objectContaining({
        path: "src/inventory.ts",
        status: "staged-deleted",
        indexState: "current",
      }),
    );
    const inventoryEvidence = brief.evidence.filter(
      (item) => item.source?.path === "src/inventory.ts",
    );
    expect(inventoryEvidence.length).toBeGreaterThan(0);
    expect(inventoryEvidence.every((item) => item.provenance.freshness === "current")).toBe(true);
  });

  it("uses a staged rename's previous path as stale graph evidence before refresh", async () => {
    root = await makeProject({
      "src/checkout.ts": "import { reserve } from './inventory.js';\nexport const checkout = reserve;\n",
      "src/inventory.ts": "export function reserve() { return true; }\n",
    });
    await initializeGit(root);
    await scan(root, { kind: "pre-refresh-rename-baseline" });
    await rename(join(root, "src/inventory.ts"), join(root, "src/stock.ts"));
    await runGit(root, ["add", "-A"]);

    const brief = await buildTaskContext(await getDb(root), root, {
      task: "review the current working tree change",
      intent: "review",
      budgetBytes: 20_000,
      isolatedGitConfig: true,
    });

    expect(brief.changeContext).not.toBe("clean");
    if (typeof brief.changeContext === "string") throw new Error("Expected a rename.");
    expect(brief.changeContext.changes).toContainEqual(
      expect.objectContaining({
        path: "src/stock.ts",
        previousPath: "src/inventory.ts",
        status: "staged-renamed",
        indexState: "historical",
      }),
    );
    expect(
      brief.evidence.some(
        (item) =>
          item.kind === "change" &&
          item.source?.path === "src/stock.ts" &&
          item.provenance.freshness === "stale",
      ),
    ).toBe(true);
    const priorPathEvidence = brief.evidence.filter(
      (item) => item.source?.path === "src/inventory.ts",
    );
    expect(priorPathEvidence.length).toBeGreaterThan(0);
    expect(priorPathEvidence.every((item) => item.provenance.freshness === "stale")).toBe(true);
  });

  it("preserves historical evidence for a deleted working-tree path", async () => {
    root = await makeProject({
      "src/checkout.ts": "import { reserve } from './inventory.js';\nexport const checkout = reserve;\n",
      "src/inventory.ts": "export function reserve() { return true; }\n",
    });
    await initializeGit(root);
    await scan(root, { kind: "change-deletion-baseline" });
    await unlink(join(root, "src/inventory.ts"));
    await scan(root, { kind: "change-deletion" });

    const brief = await buildTaskContext(await getDb(root), root, {
      task: "review the current working tree change",
      intent: "review",
      budgetBytes: 12_000,
    });

    expect(brief.changeContext).not.toBe("clean");
    if (typeof brief.changeContext === "string") throw new Error("Expected a detected deletion.");
    expect(brief.changeContext.changes).toContainEqual(
      expect.objectContaining({
        path: "src/inventory.ts",
        status: "deleted",
        indexState: "historical",
      }),
    );
    const deletion = brief.evidence.find((item) => item.source?.path === "src/inventory.ts");
    expect(deletion).toMatchObject({
      kind: "change",
      provenance: { source: "git-status-porcelain-v2", freshness: "stale" },
      source: { freshness: "stale", excerptIncluded: false },
    });
    expect(deletion?.source?.error).toBeTruthy();
    expect(brief.readFirst).not.toContain("src/inventory.ts");
  });

  it("prioritizes indexed changes and compacts change metadata to the byte budget", async () => {
    const files: Record<string, string> = {
      "src/z.ts": "export const relevantChange = 1;\n",
    };
    const unsupported: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const path = `src/a${String(index).padStart(2, "0")}-${"x".repeat(220)}.rs`;
      unsupported.push(path);
      files[path] = `pub fn ignored_${index}() {}\n`;
    }
    root = await makeProject(files);
    await initializeGit(root);
    await scan(root, { kind: "change-priority-baseline" });
    for (const path of unsupported) await appendFile(join(root, path), "// changed\n");
    await writeFile(join(root, "src/z.ts"), "export const relevantChange = 2;\n");
    await scan(root, { kind: "change-priority" });

    const brief = await buildTaskContext(await getDb(root), root, {
      task: "review the current working tree change",
      intent: "review",
      budgetBytes: 6_000,
    });

    expect(brief.budget.usedBytes).toBeLessThanOrEqual(6_000);
    expect(brief.budget.truncated).toBe(true);
    expect(brief.changeContext).not.toBe("clean");
    if (typeof brief.changeContext === "string") throw new Error("Expected detected changes.");
    expect(brief.changeContext.changes?.[0]).toMatchObject({
      path: "src/z.ts",
      indexState: "current",
    });
    expect(brief.changeContext.omittedPaths).toBeGreaterThan(0);
    expect(brief.evidence.some((item) => item.source?.path === "src/z.ts")).toBe(true);
  });

  it("ranks task, graph, authored, test, and source evidence with navigable references", async () => {
    root = await makeProject({
      "package.json": JSON.stringify({ name: "task-context" }),
      "src/checkout.ts": [
        "export function checkoutOrder(target: string) {",
        "  return target.startsWith('/') ? target : '/';",
        "}",
        "export function writeLedger() { return 'recorded'; }",
        "",
      ].join("\n"),
      "src/checkout.test.ts": [
        "import { checkoutOrder } from './checkout.js';",
        "checkoutOrder('/receipt');",
        "",
      ].join("\n"),
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    const sourceSha = db.get<{ content_sha: string }>(
      "SELECT content_sha FROM files WHERE path = ?",
      ["src/checkout.ts"],
    )!.content_sha;
    const now = new Date().toISOString();
    const memory = remember(db, {
      kind: "gotcha",
      title: "Checkout redirects stay local",
      body: "Never return an unvalidated external redirect target.",
      anchors: [{ path: "src/checkout.ts", symbol: "checkoutOrder" }],
    });
    db.run(
      `INSERT INTO findings(
         id, rule_id, category, severity, confidence, source, path, line_start, line_end,
         content_sha, title, description, status
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      [
        "unsafe-redirect",
        "fixture/redirect",
        "security",
        "high",
        "high",
        "fixture",
        "src/checkout.ts",
        2,
        2,
        sourceSha,
        "Validate checkout redirects",
        "The fallback must reject external targets.",
      ],
    );
    db.run(
      "INSERT INTO flows(id, name, summary, trigger, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
      ["checkout", "Checkout flow", "Validates and returns a receipt path.", "request", now, now],
    );
    db.run(
      `INSERT INTO flow_steps(flow_id, ordinal, label, path, symbol, note, content_sha)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        "checkout",
        0,
        "validate redirect",
        "src/checkout.ts",
        "checkoutOrder",
        "Local-only boundary.",
        sourceSha,
      ],
    );
    db.run(
      `INSERT INTO relations(
         id, kind, src_path, src_symbol, dst_path, dst_symbol, label, evidence,
         evidence_line, confidence, source, content_sha, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "checkout-ledger",
        "dispatch",
        "src/checkout.ts",
        "checkoutOrder",
        "src/checkout.ts",
        "writeLedger",
        "records checkout",
        "The checkout adapter calls the ledger registration hook.",
        2,
        "high",
        "human",
        sourceSha,
        now,
        now,
      ],
    );

    const brief = await buildTaskContext(db, root, {
      task: "debug the checkout redirect and ledger behavior",
      targets: ["src/checkout.ts"],
      intent: "debug",
      budgetBytes: 30_000,
    });
    const ids = brief.evidence.map((item) => item.id);
    expect(brief.targets[0]).toMatchObject({ status: "resolved", path: "src/checkout.ts" });
    expect(ids).toEqual(
      expect.arrayContaining([
        `memory:${memory.id}`,
        "finding:unsafe-redirect",
        "flow:checkout",
        "relation:checkout-ledger",
      ]),
    );
    expect(brief.readFirst).toEqual(
      expect.arrayContaining(["src/checkout.ts", "src/checkout.test.ts"]),
    );
    expect(brief.text).toContain("Source excerpt:");
    expect(brief.evidence.some((item) => item.id === "finding:unsafe-redirect")).toBe(true);
    expect(
      brief.evidence.every(
        (item) =>
          !item.source ||
          (item.source.path.length > 0 && item.source.startLine > 0 && item.source.endLine > 0),
      ),
    ).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(brief, null, 2), "utf8");
    expect(bytes).toBeLessThanOrEqual(30_000);
    expect(brief.budget.usedBytes).toBe(bytes);
  });

  it("compacts excerpts before dropping ranked facts and never exceeds the response budget", async () => {
    const longLine = `export const payload = "${"x".repeat(8_000)}";\n`;
    root = await makeProject({ "src/large.ts": longLine });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const brief = await buildTaskContext(db, root, {
      task: "change the payload",
      targets: ["src/large.ts"],
      intent: "implement",
      budgetBytes: 6_000,
    });
    const bytes = Buffer.byteLength(JSON.stringify(brief, null, 2), "utf8");
    expect(bytes).toBeLessThanOrEqual(6_000);
    expect(brief.budget.usedBytes).toBe(bytes);
    expect(brief.budget.truncated).toBe(true);
    expect(brief.evidence[0]?.source?.path).toBe("src/large.ts");

    const digitBoundary = await buildTaskContext(db, root, {
      task: "payload q",
      targets: ["src/large.ts"],
      intent: "implement",
      budgetBytes: 6_483,
    });
    expect(digitBoundary.budget.usedBytes).toBe(
      Buffer.byteLength(JSON.stringify(digitBoundary, null, 2), "utf8"),
    );
  });

  it("admits repeated-path facts without repeating their overlapping source first", async () => {
    root = await makeProject({
      "src/checkout.ts": [
        "import { reserveInventory } from './inventory.js';",
        "export interface CheckoutResult { status: string; reservationId?: string }",
        "export async function submitCheckout(items: string[]): Promise<CheckoutResult> {",
        "  const reservation = await reserveInventory(items);",
        "  return { status: 'accepted', reservationId: reservation.id };",
        "}",
        "",
      ].join("\n"),
      "src/inventory.ts": [
        "export interface Reservation { id: string }",
        "export async function reserveInventory(items: string[]): Promise<Reservation> {",
        "  return { id: `reservation-${items.length}` };",
        "}",
        "",
      ].join("\n"),
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    remember(db, {
      kind: "constraint",
      title: "Checkout reservation rule",
      body: "Keep the reservation id attached to the result.",
      anchors: [{ path: "src/checkout.ts", symbol: "submitCheckout" }],
    });

    const brief = await buildTaskContext(db, root, {
      task: "review submitCheckout inventory reservation",
      intent: "review",
      budgetBytes: 6_000,
    });
    const checkoutEvidence = brief.evidence.filter(
      (item) => item.source?.path === "src/checkout.ts",
    );
    expect(checkoutEvidence.length).toBeGreaterThan(1);
    expect(brief.evidence.length).toBeLessThanOrEqual(3);
    expect(
      checkoutEvidence.filter((item) => item.source?.excerptIncluded).length,
    ).toBe(1);
    expect(brief.strategy.sourcePacking).toBe("rank-order-path-diverse-utf8-budget");
    expect(brief.budget.usedBytes).toBeLessThanOrEqual(6_000);
  });

  it("marks selected evidence stale when the working source changes after indexing", async () => {
    root = await makeProject({
      "src/policy.ts": "export function policy() { return 'old'; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    remember(db, {
      kind: "decision",
      title: "Policy compatibility",
      body: "Keep the persisted value readable.",
      anchors: [{ path: "src/policy.ts", symbol: "policy" }],
    });
    await writeFile(join(root, "src/policy.ts"), "export function policy() { return 'new'; }\n");

    const brief = await buildTaskContext(db, root, {
      task: "review policy compatibility",
      targets: ["src/policy.ts"],
      intent: "review",
      budgetBytes: 20_000,
    });
    expect(brief.evidence.some((item) => item.source?.freshness === "stale")).toBe(true);
    expect(brief.followUps).toContain("Re-index before trusting stale source-backed evidence.");
  });

  it("anchors outgoing graph facts to the source revision that produced them", async () => {
    root = await makeProject({
      "src/a.ts": "import { dep } from './b.js';\nexport function run() { return dep(); }\n",
      "src/b.ts": "export function dep() { return 1; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    await writeFile(join(root, "src/a.ts"), "export function run() { return 2; }\n");

    const brief = await buildTaskContext(db, root, {
      targets: ["src/a.ts"],
      intent: "review",
      budgetBytes: 30_000,
    });
    const dependency = brief.evidence.find((item) => item.kind === "dependency");
    const outgoingReference = brief.evidence.find(
      (item) => item.kind === "reference" && item.title.includes("src/b.ts#dep"),
    );
    expect(dependency?.source).toMatchObject({ path: "src/a.ts", freshness: "stale" });
    expect(outgoingReference?.source).toMatchObject({ path: "src/a.ts", freshness: "stale" });
  });

  it("navigates dependency evidence to the exact import statement", async () => {
    root = await makeProject({
      "src/a.ts": `${Array.from({ length: 60 }, (_, index) => `// setup ${index + 1}`).join(
        "\n",
      )}\nimport './b.js';\n`,
      "src/b.ts": "export const value = 1;\n",
    });
    await scan(root, { kind: "full" });

    const brief = await buildTaskContext(await getDb(root), root, {
      targets: ["src/a.ts"],
      budgetBytes: 30_000,
    });
    const dependency = brief.evidence.find((item) => item.kind === "dependency");
    expect(dependency?.source?.startLine).toBeLessThanOrEqual(61);
    expect(dependency?.source?.endLine).toBeGreaterThanOrEqual(61);
    expect(brief.text).toContain("import './b.js';");
  });

  it("keeps stale compiler generations stale when the caller text is unchanged", async () => {
    root = await makeProject({
      "tsconfig.json": JSON.stringify({ files: ["src/main.ts", "src/store.ts"] }),
      "src/main.ts":
        'import { save } from "./store";\nexport function run() { return save(); }\n',
      "src/store.ts": "export function save() { return true; }\n",
      "src/other.ts": "export const value = 1;\nconsole.log(value);\n",
    });
    await scan(root, { full: true, kind: "full" });
    const db = await getDb(root);
    expect(resolveTypes(db, root).ran).toBe(true);

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ files: ["src/other.ts"] }),
    );
    await scan(root, { kind: "incremental" });
    expect(resolveTypes(db, root).ran).toBe(true);

    const brief = await buildTaskContext(db, root, {
      targets: ["src/store.ts"],
      intent: "review",
      budgetBytes: 30_000,
    });
    const staleReference = brief.evidence.find(
      (item) => item.kind === "reference" && item.source?.path === "src/main.ts",
    );
    expect(staleReference?.source?.freshness).toBe("stale");
  });

  it("resolves an exact repository path before considering longer suffix matches", async () => {
    root = await makeProject({
      "src/foo.ts": "export const rootFoo = 1;\n",
      "packages/x/src/foo.ts": "export const nestedFoo = 2;\n",
    });
    await scan(root, { kind: "full" });
    const brief = await buildTaskContext(await getDb(root), root, {
      targets: ["src/foo.ts"],
      budgetBytes: 20_000,
    });
    expect(brief.targets[0]).toMatchObject({
      status: "resolved",
      kind: "file",
      path: "src/foo.ts",
    });
  });

  it("retrieves covering tests independently and navigates to the caller line", async () => {
    const files: Record<string, string> = {
      "src/api.ts": "export function run() { return 1; }\n",
    };
    for (let index = 0; index < 31; index += 1) {
      files[`src/a${String(index).padStart(2, "0")}.ts`] =
        "import { run } from './api.js';\nexport const value = run();\n";
    }
    files["src/z.test.ts"] = `${Array.from(
      { length: 60 },
      (_, index) => `// setup ${index + 1}`,
    ).join("\n")}\nimport { run } from './api.js';\nrun();\n`;
    root = await makeProject(files);
    await scan(root, { kind: "full" });

    const brief = await buildTaskContext(await getDb(root), root, {
      targets: ["src/api.ts"],
      intent: "review",
      budgetBytes: 100_000,
    });
    const coveringTest = brief.evidence.find(
      (item) => item.kind === "reference" && item.source?.path === "src/z.test.ts",
    );
    expect(coveringTest?.source?.startLine).toBeGreaterThan(40);
    expect(brief.text).toContain("run();");
    expect(brief.budget.truncated).toBe(true);
    expect(brief.omissions.plannerCandidates).toBeGreaterThan(0);
  });

  it("expands graph context from a task-only authored-memory match", async () => {
    root = await makeProject({
      "src/api.ts": "export function run() { return 1; }\n",
      "src/api.test.ts": "import { run } from './api.js';\nrun();\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    remember(db, {
      kind: "gotcha",
      title: "Flibbertigibbet failure",
      body: "Quuxwomble is the diagnostic marker.",
      anchors: [{ path: "src/api.ts", symbol: "run" }],
    });

    const brief = await buildTaskContext(db, root, {
      task: "diagnose quuxwomble",
      intent: "debug",
      budgetBytes: 30_000,
    });
    expect(
      brief.evidence.some(
        (item) => item.kind === "reference" && item.source?.path === "src/api.test.ts",
      ),
    ).toBe(true);
  });

  it("expands every bounded anchor of a task-only authored-memory match", async () => {
    root = await makeProject({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export function b() { return 1; }\n",
      "src/b.test.ts": "import { b } from './b.js';\nb();\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    remember(db, {
      kind: "gotcha",
      title: "Quuxwomble marker",
      body: "Unique flibbertigibbet behavior applies to both anchors.",
      anchors: [
        { path: "src/a.ts", symbol: "a" },
        { path: "src/b.ts", symbol: "b" },
      ],
    });

    const brief = await buildTaskContext(db, root, {
      task: "diagnose flibbertigibbet",
      budgetBytes: 30_000,
    });
    expect(
      brief.evidence.some(
        (item) => item.kind === "reference" && item.source?.path === "src/b.test.ts",
      ),
    ).toBe(true);
  });

  it("does not count duplicate anchors of one retained memory as omissions", async () => {
    root = await makeProject({ "src/a.ts": "export const a = 1;\n" });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    remember(db, {
      kind: "context",
      title: "Many local anchors",
      anchors: Array.from({ length: 21 }, (_, index) => ({
        path: "src/a.ts",
        symbol: `anchor${index}`,
      })),
    });

    const plan = db.taskContext("", ["src/a.ts"], "understand", 64);
    expect(plan.candidates.map((candidate) => candidate.kind)).toEqual(
      expect.arrayContaining(["file", "memory"]),
    );
    expect(plan.omittedCandidates).toBe(0);
  });

  it("restricts covering tests to an explicit symbol instead of sibling exports", async () => {
    const files: Record<string, string> = {
      "src/api.ts":
        "export function run() { return 1; }\nexport function sibling() { return 2; }\n",
    };
    for (let index = 0; index < 31; index += 1) {
      files[`src/a${String(index).padStart(2, "0")}.ts`] =
        "import { run } from './api.js';\nrun();\n";
    }
    files["src/z.test.ts"] =
      "import { sibling } from './api.js';\nsibling();\n";
    root = await makeProject(files);
    await scan(root, { kind: "full" });

    const brief = await buildTaskContext(await getDb(root), root, {
      targets: ["run"],
      intent: "review",
      budgetBytes: 100_000,
    });
    expect(
      brief.evidence.some(
        (item) => item.kind === "reference" && item.source?.path === "src/z.test.ts",
      ),
    ).toBe(false);
  });

  it("keeps file-wide covering tests when a file and one of its symbols are both explicit", async () => {
    const files: Record<string, string> = {
      "src/api.ts":
        "export function run() { return 1; }\nexport function sibling() { return 2; }\n",
    };
    for (let index = 0; index < 31; index += 1) {
      files[`src/a${String(index).padStart(2, "0")}.ts`] =
        "import { run } from './api.js';\nrun();\n";
    }
    files["src/z.test.ts"] =
      "import { sibling } from './api.js';\nsibling();\n";
    root = await makeProject(files);
    await scan(root, { kind: "full" });

    const brief = await buildTaskContext(await getDb(root), root, {
      targets: ["src/api.ts", "run"],
      intent: "review",
      budgetBytes: 100_000,
    });
    expect(
      brief.evidence.some(
        (item) => item.kind === "reference" && item.source?.path === "src/z.test.ts",
      ),
    ).toBe(true);
  });

  it("keeps import-resolved reference certainty inferred", async () => {
    root = await makeProject({
      "src/api.ts": "export function run() { return 1; }\n",
      "src/use.ts": "import { run } from './api.js';\nrun();\n",
    });
    await scan(root, { kind: "full" });
    const brief = await buildTaskContext(await getDb(root), root, {
      targets: ["src/api.ts"],
      budgetBytes: 20_000,
    });
    const reference = brief.evidence.find(
      (item) => item.kind === "reference" && item.source?.path === "src/use.ts",
    );
    expect(reference?.provenance).toMatchObject({
      source: "import-reference-index",
      certainty: "inferred",
    });
  });

  it("does not guess when a symbol target is ambiguous", async () => {
    root = await makeProject({
      "src/a.ts": "export function run() { return 'a'; }\n",
      "src/b.ts": "export function run() { return 'b'; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const brief = await buildTaskContext(db, root, {
      targets: ["run"],
      budgetBytes: 12_000,
    });
    expect(brief.targets[0]).toMatchObject({ status: "ambiguous", kind: "symbol" });
    expect(brief.uncertainties).toContain(
      "At least one explicit target is ambiguous and was not guessed; refine it to add graph neighbours.",
    );
    expect(brief.followUps[0]).toContain("Refine ambiguous targets");
    const candidates = brief.targets[0]?.candidates ?? [];
    expect(new Set(candidates).size).toBe(2);
    const retried = await buildTaskContext(db, root, {
      targets: [candidates[0]!],
      budgetBytes: 12_000,
    });
    expect(retried.targets[0]).toMatchObject({ status: "resolved", kind: "symbol" });
  });

  it("uses the target-specific anchor when one memory applies to several files", async () => {
    root = await makeProject({
      "src/a.ts": "export function first() { return 1; }\n",
      "src/b.ts": "export function second() { return 2; }\n",
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    const memory = remember(db, {
      kind: "constraint",
      title: "Shared compatibility rule",
      body: "Both implementations must retain the same output shape.",
      anchors: [
        { path: "src/a.ts", symbol: "first" },
        { path: "src/b.ts", symbol: "second" },
      ],
    });

    const brief = await buildTaskContext(db, root, {
      targets: ["src/b.ts"],
      budgetBytes: 20_000,
    });
    expect(brief.evidence.find((item) => item.id === `memory:${memory.id}`)?.source).toMatchObject({
      path: "src/b.ts",
      symbol: "second",
    });
  });

  it("uses the exact targeted symbol when one memory has several anchors in a file", async () => {
    root = await makeProject({
      "src/shared.ts": [
        "export function first() { return 1; }",
        "",
        "export function second() { return 2; }",
        "",
      ].join("\n"),
    });
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    const memory = remember(db, {
      kind: "constraint",
      title: "Shared symbol rule",
      body: "Both entry points retain their behavior.",
      anchors: [
        { path: "src/shared.ts", symbol: "first" },
        { path: "src/shared.ts", symbol: "second" },
      ],
    });

    const brief = await buildTaskContext(db, root, {
      task: "review the shared symbol rule",
      targets: ["second"],
      budgetBytes: 20_000,
    });
    expect(brief.evidence.find((item) => item.id === `memory:${memory.id}`)?.source).toMatchObject({
      path: "src/shared.ts",
      symbol: "second",
    });
  });

  it("evolves the existing brief tool without growing the MCP catalog", async () => {
    root = await makeProject({
      "src/app.ts": "export function startApplication() { return 'ready'; }\n",
      "src/app.test.ts":
        "import { startApplication } from './app.js';\nstartApplication();\n",
    });
    const server = createMcpServer({ defaultRoot: null });
    const client = new Client({ name: "task-context-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(33);
      await client.callTool({
        name: "audit_scan",
        arguments: { projectRoot: root },
      });
      const taskFirst = await client.callTool({
        name: "brief",
        arguments: {
          projectRoot: root,
          task: "understand startApplication startup",
          intent: "understand",
          budget: 8_000,
        },
      });
      expect(taskFirst.isError).not.toBe(true);
      const taskContent = taskFirst.content[0];
      const taskResponse = JSON.parse(
        taskContent?.type === "text" ? taskContent.text : "{}",
      ) as {
        schemaVersion?: number;
        evidence?: Array<{ source?: { path?: string } }>;
      };
      expect(taskResponse.schemaVersion).toBe(3);
      expect(taskResponse.evidence?.length).toBeGreaterThan(0);
      expect(
        taskResponse.evidence?.some((item) => item.source?.path === "src/app.test.ts"),
      ).toBe(true);

      const legacyTarget = await client.callTool({
        name: "brief",
        arguments: { projectRoot: root, target: "src/app.ts", budget: 8_000 },
      });
      expect(legacyTarget.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
