/**
 * Type-precise references.
 *
 * The Rust scan resolves imported names, which is fast and covers most of the
 * graph but cannot see `db.run(...)` — the method belongs to a type, and
 * nothing was imported by that name. Getting those right needs a type checker.
 *
 * scip-typescript is a wrapper over the very compiler API used here, so going
 * through it would mean shelling out to an indexer and decoding protobuf to
 * obtain what `getSymbolAtLocation` returns directly. This asks the compiler.
 *
 * It is slow — a full type-check of the project — so it runs after the fast
 * pass rather than instead of it, and upgrades the rows it can. That trade is
 * only available because a daemon can afford a slow background job; a server
 * spawned per session never could.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { Db } from "../db/db.js";

/**
 * Marks a ref as already resolved by the type checker. The import resolver
 * must leave these alone — it would try to resolve this as a module path,
 * fail, and null out the very rows the typed pass just established.
 */
export const TYPED_SPECIFIER = "typed";

/** Destination identity participates in the existing refs primary key. */
export function typedSpecifier(destination: string, line: number, column: number): string {
  return `${TYPED_SPECIFIER}:${destination}:${line}:${column}`;
}

export interface TypedResult {
  ran: boolean;
  reason?: string;
  filesAnalysed: number;
  resolved: number;
  upgraded: number;
  durationMs: number;
}

export interface TypedReference {
  src: string;
  line: number;
  column: number;
  name: string;
  dst: string;
  dstLine: number;
  dstColumn: number;
}

export interface TypedAnalysis {
  ran: boolean;
  reason?: string;
  filesAnalysed: number;
  references: TypedReference[];
  /** Every source whose existing refs can be replaced by this complete pass. */
  analysedFiles: string[];
  /** Inputs prove a worker result still describes the generation in the store. */
  inputs: Array<{ path: string; contentSha: string }>;
  durationMs: number;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Walk into the declaration an identifier actually refers to.
 *
 * Imports produce alias symbols that point at the import statement rather than
 * the definition, so aliases are followed before the declaration is taken.
 */
function declarationFor(
  checker: ts.TypeChecker,
  node: ts.Identifier,
): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;

  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      // Unresolvable alias — fall through to whatever we have.
    }
  }
  return symbol.declarations?.[0];
}

/** The name a declaration is known by, which is what refs rows are keyed on. */
function declaredName(declaration: ts.Declaration): string | null {
  const named = declaration as ts.NamedDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  return null;
}

/**
 * Naming something in an import or re-export is not using it.
 *
 * The checker happily resolves the identifier in `import { foo } from "./x"`
 * back to foo's declaration, which would count every import as a call site and
 * disagree with the fast pass about the same code.
 */
function isImportOrExportName(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportEqualsDeclaration(current) ||
      ts.isExportDeclaration(current)
    ) {
      return true;
    }
    // Stop at the statement level; nothing above it can be an import clause.
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".venv"]);

/**
 * Every project config in the repository, not just the nearest one upward.
 *
 * A monorepo has no tsconfig.json at its root — each package carries its own,
 * and the root file, if any, is a base others extend. Searching upward from
 * the repository root therefore finds nothing, which is how this silently did
 * no work the first time.
 */
function findConfigs(projectRoot: string, maxDepth = 4): string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;

    let files: string[];
    let directories: string[];
    try {
      files = ["tsconfig.json", "jsconfig.json"]
        .map((name) => join(dir, name))
        .filter(ts.sys.fileExists);
      directories = ts.sys.getDirectories(dir);
    } catch {
      return;
    }

    for (const file of files) found.push(resolve(file));
    for (const child of directories) {
      const name = basename(child);
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      walk(isAbsolute(child) ? child : join(dir, child), depth + 1);
    }
  };

  walk(projectRoot, 0);

  // A root config usually pulls in everything via includes, so prefer it alone
  // when it is a single project. A mixed config can both own files and refer to
  // package projects; returning only the root in that shape silently drops the
  // referenced packages because createProgram does not index their sources as
  // part of the root program.
  const rootConfig = found.find(
    (file) =>
      file === resolve(projectRoot, "tsconfig.json") ||
      file === resolve(projectRoot, "jsconfig.json"),
  );
  if (rootConfig) {
    const parsed = readConfig(rootConfig);
    if (parsed && parsed.fileNames.length > 0 && !parsed.projectReferences?.length) {
      return [rootConfig];
    }

    // References are authoritative even when their config sits below the
    // normal discovery depth. Follow them recursively and still retain any
    // independently discovered projects in a mixed monorepo.
    const referenced: string[] = [];
    const visitReferences = (configPath: string): void => {
      const config = readConfig(configPath);
      for (const reference of config?.projectReferences ?? []) {
        const child = resolve(ts.resolveProjectReferencePath(reference));
        if (referenced.includes(child)) continue;
        referenced.push(child);
        visitReferences(child);
      }
    };
    visitReferences(rootConfig);
    found.push(...referenced);
  }
  return [...new Set(found)].sort((a, b) => {
    const depth = (path: string) => relative(projectRoot, path).split(/[\\/]/).length;
    return depth(a) - depth(b) || a.localeCompare(b);
  });
}

function readConfig(configPath: string): ts.ParsedCommandLine | undefined {
  return ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  } as ts.ParseConfigFileHost);
}

function contentSha(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Compute type-precise references without touching the database.
 *
 * This is intentionally serializable so the daemon can run it in a worker;
 * TypeScript program construction and AST traversal are CPU-bound and must not
 * make health checks and MCP requests wait behind a large repository.
 */
export function analyseTypes(projectRoot: string): TypedAnalysis {
  const started = Date.now();
  const configs = findConfigs(projectRoot);

  if (configs.length === 0) {
    return {
      ran: false,
      reason: "No tsconfig.json found — typed resolution is TypeScript/JavaScript only.",
      filesAnalysed: 0,
      references: [],
      analysedFiles: [],
      inputs: [],
      durationMs: Date.now() - started,
    };
  }

  const inRepo = (fileName: string): string | null => {
    const absolute = isAbsolute(fileName) ? fileName : join(projectRoot, fileName);
    const rel = toPosix(relative(projectRoot, absolute));
    if (!rel || rel.startsWith("..")) return null;
    if (rel.includes("node_modules/")) return null;
    return rel;
  };

  const found: TypedReference[] = [];
  const analysed = new Set<string>();
  const inputs = new Map<string, string>();
  let filesAnalysed = 0;

  for (const configPath of configs) {
    const path = inRepo(configPath);
    if (!path) continue;
    try {
      inputs.set(path, contentSha(readFileSync(configPath, "utf-8")));
    } catch {
      // readConfig will report the unusable config by producing no files.
    }
  }

  // One program per config. Merging every package's compilerOptions into one
  // bag let the first-walked package's `paths` and `baseUrl` win for all of
  // them, so whole packages type-checked with the wrong module resolution —
  // their imports resolved to nothing, and the pass then *downgraded* their
  // refs instead of upgrading them. Options are per-package facts.
  for (const configPath of configs) {
    const parsed = readConfig(configPath);
    if (!parsed || parsed.fileNames.length === 0) continue;

    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: {
        ...parsed.options,
        // Declarations and emit are irrelevant here; skipping them is most of
        // the difference between this being slow and being unusable.
        noEmit: true,
        skipLibCheck: true,
        skipDefaultLibCheck: true,
      },
      projectReferences: parsed.projectReferences,
    });
    const checker = program.getTypeChecker();

    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      const src = inRepo(sourceFile.fileName);
      if (!src) continue;
      // A file pulled into several programs is analysed under the first
      // config that owns it, which the walk visits shallowest-first.
      if (analysed.has(sourceFile.fileName)) continue;
      analysed.add(sourceFile.fileName);
      filesAnalysed++;
      inputs.set(src, contentSha(sourceFile.text));

      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && !isImportOrExportName(node)) {
          const declaration = declarationFor(checker, node);
          if (declaration) {
            const declFile = declaration.getSourceFile();
            const dst = declFile.isDeclarationFile ? null : inRepo(declFile.fileName);
            const name = declaredName(declaration);

            // Skip the declaration site itself: defining a thing is not using it.
            const isSelf =
              declFile.fileName === sourceFile.fileName &&
              declaration.getStart() <= node.getStart() &&
              node.getEnd() <= declaration.getEnd() &&
              (declaration as ts.NamedDeclaration).name === node;

            if (dst && name && !isSelf) {
              const sourcePosition = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              const declaredNode = (declaration as ts.NamedDeclaration).name;
              const destinationPosition = declFile.getLineAndCharacterOfPosition(
                declaredNode?.getStart() ?? declaration.getStart(),
              );
              found.push({
                src,
                line: sourcePosition.line + 1,
                column: sourcePosition.character,
                name,
                dst,
                dstLine: destinationPosition.line + 1,
                dstColumn: destinationPosition.character,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  if (filesAnalysed === 0) {
    return {
      ran: false,
      reason: `Found ${configs.length} config(s) but no files to analyse.`,
      filesAnalysed: 0,
      references: [],
      analysedFiles: [],
      inputs: [...inputs].map(([path, sha]) => ({ path, contentSha: sha })),
      durationMs: Date.now() - started,
    };
  }

  return {
    ran: true,
    filesAnalysed,
    references: found,
    analysedFiles: [
      ...new Set(
        found
          .map((reference) => reference.src)
          .concat(
            [...analysed]
              .map((file) => inRepo(file))
              .filter((path): path is string => Boolean(path)),
          ),
      ),
    ],
    inputs: [...inputs].map(([path, sha]) => ({ path, contentSha: sha })),
    durationMs: Date.now() - started,
  };
}

/** Apply one complete worker result in a short, synchronous transaction. */
export function applyTypedAnalysis(db: Db, analysis: TypedAnalysis): TypedResult {
  if (!analysis.ran) {
    return {
      ran: false,
      ...(analysis.reason ? { reason: analysis.reason } : {}),
      filesAnalysed: analysis.filesAnalysed,
      resolved: 0,
      upgraded: 0,
      durationMs: analysis.durationMs,
    };
  }

  // A scan may complete while the worker is still analysing the previous
  // generation. Never let that stale result overwrite refs for newer code or
  // compiler configuration; the next scheduled pass will use the new inputs.
  const current = new Map(
    db
      .all<{ path: string; content_sha: string }>(
        "SELECT path, content_sha FROM files WHERE present = 1",
      )
      .map((row) => [row.path, row.content_sha]),
  );
  const changed = analysis.inputs.find((input) => current.get(input.path) !== input.contentSha);
  if (changed) {
    return {
      ran: false,
      reason: `Typed inputs changed while resolving (${changed.path}); retry scheduled.`,
      filesAnalysed: analysis.filesAnalysed,
      resolved: 0,
      upgraded: 0,
      durationMs: analysis.durationMs,
    };
  }

  const refsBySrc = new Map<string, TypedReference[]>();
  for (const src of analysis.analysedFiles) refsBySrc.set(src, []);
  for (const reference of analysis.references) {
    const list = refsBySrc.get(reference.src);
    if (list) list.push(reference);
    else refsBySrc.set(reference.src, [reference]);
  }

  const before = db.count("SELECT COUNT(*) AS n FROM refs WHERE dst_path IS NOT NULL");
  const seen = new Set<string>();
  db.transaction(() => {
    for (const [src, refs] of refsBySrc) {
      db.run("DELETE FROM refs WHERE src_path = ?", [src]);
      for (const reference of refs) {
        const key = `${reference.src}|${reference.line}|${reference.column}|${reference.name}|${reference.dst}|${reference.dstLine}|${reference.dstColumn}`;
        if (seen.has(key)) continue;
        seen.add(key);
        db.run(
          `INSERT OR REPLACE INTO refs(src_path, src_line, src_column, name, specifier,
                                      dst_path, dst_line, dst_column)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            reference.src,
            reference.line,
            reference.column,
            reference.name,
            typedSpecifier(reference.dst, reference.dstLine, reference.dstColumn),
            reference.dst,
            reference.dstLine,
            reference.dstColumn,
          ],
        );
      }
      db.run("UPDATE files SET ref_coverage = 'typed' WHERE path = ?", [src]);
    }
    db.refreshReferenceIdentity();
  });

  const after = db.count("SELECT COUNT(*) AS n FROM refs WHERE dst_path IS NOT NULL");

  return {
    ran: true,
    filesAnalysed: analysis.filesAnalysed,
    resolved: seen.size,
    upgraded: after - before,
    durationMs: analysis.durationMs,
  };
}

/** Synchronous compatibility path for tests and direct library callers. */
export function resolveTypes(db: Db, projectRoot: string): TypedResult {
  return applyTypedAnalysis(db, analyseTypes(projectRoot));
}

interface WorkerReply {
  analysis?: TypedAnalysis;
  error?: string;
}

/** Run the expensive compiler pass off the event loop, then commit its facts. */
export function resolveTypesInWorker(db: Db, projectRoot: string): Promise<TypedResult> {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(new URL("./typed-worker.js", import.meta.url), {
      workerData: { projectRoot },
      // A host launched through `node --input-type=module -e` cannot pass that
      // flag on to a file-backed worker; Node rejects the otherwise valid URL.
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
    });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    worker.once("message", (reply: WorkerReply) => {
      if (settled) return;
      settled = true;
      if (reply.error) reject(new Error(reply.error));
      else if (!reply.analysis) reject(new Error("Typed worker returned no analysis."));
      else {
        try {
          resolveResult(applyTypedAnalysis(db, reply.analysis));
        } catch (error) {
          reject(error);
        }
      }
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (code !== 0) fail(new Error(`Typed worker exited with code ${code}.`));
    });
  });
}
