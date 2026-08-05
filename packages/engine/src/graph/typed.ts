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


import { isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript";
import type { Db } from "../db/db.js";

/**
 * Marks a ref as already resolved by the type checker. The import resolver
 * must leave these alone — it would try to resolve this as a module path,
 * fail, and null out the very rows the typed pass just established.
 */
export const TYPED_SPECIFIER = "typed";

export interface TypedResult {
  ran: boolean;
  reason?: string;
  filesAnalysed: number;
  resolved: number;
  upgraded: number;
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
      files = ts.sys
        .readDirectory(dir, undefined, undefined, undefined, 1)
        .filter((file) => {
          const name = file.split(/[\\/]/).pop() ?? "";
          return name === "tsconfig.json" || name === "jsconfig.json";
        });
      directories = ts.sys.getDirectories(dir);
    } catch {
      return;
    }

    for (const file of files) found.push(file);
    for (const child of directories) {
      if (SKIP_DIRS.has(child) || child.startsWith(".")) continue;
      walk(join(dir, child), depth + 1);
    }
  };

  walk(projectRoot, 0);

  // A root config usually pulls in everything via references or includes, so
  // prefer it alone and avoid type-checking the same files several times.
  const rootConfig = found.find(
    (file) => file === join(projectRoot, "tsconfig.json") || file === join(projectRoot, "jsconfig.json"),
  );
  if (rootConfig) {
    const parsed = readConfig(rootConfig);
    if (parsed && parsed.fileNames.length > 0) return [rootConfig];
  }
  return found;
}

function readConfig(configPath: string): ts.ParsedCommandLine | undefined {
  return ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  } as ts.ParseConfigFileHost);
}

export function resolveTypes(db: Db, projectRoot: string): TypedResult {
  const started = Date.now();
  const configs = findConfigs(projectRoot);

  if (configs.length === 0) {
    return {
      ran: false,
      reason: "No tsconfig.json found — typed resolution is TypeScript/JavaScript only.",
      filesAnalysed: 0,
      resolved: 0,
      upgraded: 0,
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

  interface TypedRef {
    src: string;
    line: number;
    name: string;
    dst: string;
  }
  const found: TypedRef[] = [];
  const analysed = new Set<string>();
  let filesAnalysed = 0;

  // One program per config. Merging every package's compilerOptions into one
  // bag let the first-walked package's `paths` and `baseUrl` win for all of
  // them, so whole packages type-checked with the wrong module resolution —
  // their imports resolved to nothing, and the pass then *downgraded* their
  // refs instead of upgrading them. Options are per-package facts.
  for (const configPath of configs) {
    const parsed = readConfig(configPath);
    if (!parsed || parsed.fileNames.length === 0) continue;

    const program = ts.createProgram(parsed.fileNames, {
      ...parsed.options,
      // Declarations and emit are irrelevant here; skipping them is most of
      // the difference between this being slow and being unusable.
      noEmit: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
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
              const line =
                sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              found.push({ src, line, name, dst });
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
      resolved: 0,
      upgraded: 0,
      durationMs: Date.now() - started,
    };
  }

  // Replace rows only for files the checker produced references *for*. A file
  // it saw but resolved nothing in keeps its import-resolved rows — this pass
  // upgrades the graph or leaves it alone, never thins it.
  const refsBySrc = new Map<string, TypedRef[]>();
  for (const reference of found) {
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
        const key = `${reference.src}|${reference.line}|${reference.name}|${reference.dst}`;
        if (seen.has(key)) continue;
        seen.add(key);
        db.run(
          "INSERT OR REPLACE INTO refs(src_path, src_line, name, specifier, dst_path) VALUES(?, ?, ?, ?, ?)",
          [reference.src, reference.line, reference.name, TYPED_SPECIFIER, reference.dst],
        );
      }
    }
    // Same attribution as the fast pass — the typed pass replaced these rows.
    db.run(
      `UPDATE refs SET src_symbol = (
         SELECT s.name FROM symbols s
         WHERE s.path = refs.src_path
           AND s.start_line <= refs.src_line
           AND s.end_line   >= refs.src_line
         ORDER BY (s.end_line - s.start_line) ASC
         LIMIT 1
       )`,
    );
  });

  const after = db.count("SELECT COUNT(*) AS n FROM refs WHERE dst_path IS NOT NULL");

  return {
    ran: true,
    filesAnalysed,
    resolved: seen.size,
    upgraded: after - before,
    durationMs: Date.now() - started,
  };
}
