import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../db/db.js";
import { scan } from "../scan/scan.js";
import { cleanup, makeProject, writeFiles } from "./helpers.js";

const PROJECT = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
  }),
  "src/auth/login.ts": `
import { hash } from "../lib/crypto";
import express from "express";

export function login(user: string) {
  return hash(user);
}
export class Session {}
`,
  "src/lib/crypto.ts": `
export function hash(value: string): string {
  return value;
}
`,
  "src/api/routes.ts": `
import { login } from "@/auth/login";
export const handler = () => login("a");
`,
  "svc/app.py": `
from .models import User
import os

def create_user(name):
    return User(name)

class Service:
    def run(self):
        pass
`,
  "svc/models.py": `
class User:
    def __init__(self, name):
        self.name = name
`,
  "src/auth/login.test.ts": `import { login } from "./login";\n`,
};

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("scan", () => {
  it("indexes files, symbols and resolved imports", async () => {
    root = await makeProject(PROJECT);
    const result = await scan(root, { kind: "full" });

    expect(result.filesTotal).toBe(7);
    expect(result.filesParsed).toBe(6);
    expect(result.symbols).toBeGreaterThan(0);

    const db = await getDb(root);

    const symbols = db.all<{ name: string; kind: string; exported: number }>(
      "SELECT name, kind, exported FROM symbols WHERE path = 'src/auth/login.ts'",
    );
    expect(symbols.map((s) => s.name).sort()).toEqual(["Session", "login"]);
    expect(symbols.every((s) => s.exported === 1)).toBe(true);

    const py = db.all<{ name: string; kind: string }>(
      "SELECT name, kind FROM symbols WHERE path = 'svc/app.py' ORDER BY name",
    );
    expect(py).toEqual([
      { name: "Service", kind: "class" },
      { name: "create_user", kind: "function" },
      { name: "run", kind: "method" },
    ]);
  });

  it("resolves relative, aliased and python imports to real files", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);

    const edge = (src: string, spec: string) =>
      db.get<{ dst_path: string | null; external: string | null }>(
        "SELECT dst_path, external FROM edges WHERE src_path = ? AND specifier = ?",
        [src, spec],
      );

    expect(edge("src/auth/login.ts", "../lib/crypto")?.dst_path).toBe("src/lib/crypto.ts");
    expect(edge("src/api/routes.ts", "@/auth/login")?.dst_path).toBe("src/auth/login.ts");
    expect(edge("svc/app.py", ".models")?.dst_path).toBe("svc/models.py");
    expect(edge("src/auth/login.ts", "express")?.external).toBe("express");
    expect(edge("svc/app.py", "os")?.external).toBe("os");
  });

  it("re-parses only changed files on a second scan", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });

    const unchanged = await scan(root, { kind: "incremental" });
    expect(unchanged.filesChanged).toBe(0);
    expect(unchanged.filesParsed).toBe(0);

    await writeFiles(root, {
      "src/lib/crypto.ts": `export function hash(v: string) { return v; }\nexport function verify() {}\n`,
    });

    const second = await scan(root, { kind: "incremental" });
    expect(second.filesChanged).toBe(1);
    expect(second.filesParsed).toBe(1);

    const db = await getDb(root);
    const names = db
      .all<{ name: string }>("SELECT name FROM symbols WHERE path = 'src/lib/crypto.ts' ORDER BY name")
      .map((r) => r.name);
    expect(names).toEqual(["hash", "verify"]);
  });

  it("retires deleted files and their graph", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });

    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(root, "src/api/routes.ts"));

    const result = await scan(root, { kind: "incremental" });
    expect(result.filesRemoved).toBe(1);

    const db = await getDb(root);
    expect(db.count("SELECT COUNT(*) AS n FROM symbols WHERE path = 'src/api/routes.ts'")).toBe(0);
    expect(
      db.get<{ present: number }>("SELECT present FROM files WHERE path = 'src/api/routes.ts'")
        ?.present,
    ).toBe(0);
  });

  it("marks test files", async () => {
    root = await makeProject(PROJECT);
    await scan(root, { kind: "full" });
    const db = await getDb(root);
    expect(
      db.get<{ is_test: number }>("SELECT is_test FROM files WHERE path = 'src/auth/login.test.ts'")
        ?.is_test,
    ).toBe(1);
  });
});
