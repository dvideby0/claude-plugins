/**
 * Import specifier → repo file, or an external package name.
 * Resolution is purely lexical against the set of scanned files.
 */

import { createHash } from "node:crypto";

export interface Resolver {
  resolve(fromPath: string, specifier: string): { dstPath: string | null; external: string | null };
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TS_INDEX = TS_EXTENSIONS.map((ext) => `/index${ext}`);

/**
 * TypeScript ESM imports name the emitted file (`./db.js`) while the source on
 * disk is `./db.ts`. Without this the graph misses nearly every internal edge
 * in a modern TS project.
 */
const EMITTED_TO_SOURCE: Array<[RegExp, string[]]> = [
  [/\.js$/, [".ts", ".tsx"]],
  [/\.mjs$/, [".mts"]],
  [/\.cjs$/, [".cts"]],
  [/\.jsx$/, [".tsx"]],
];

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** Normalise `a/b/../c` → `a/c`. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export interface TsPathAlias {
  prefix: string;
  targets: string[];
}

// Strip JSONC comments without corrupting strings.
//
// A regex cannot do this: a paths key ends in slash-star and an include glob
// contains star-slash, so the two read as a comment opener and closer, and
// everything between them — usually the aliases this parser exists to find —
// is deleted. Walked character-wise instead, with string literals passed
// through untouched.
function stripJsonComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      out += char;
      for (i++; i < text.length; i++) {
        out += text[i];
        if (text[i] === "\\") {
          out += text[i + 1] ?? "";
          i++;
        } else if (text[i] === '"') break;
      }
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

/** Parse `compilerOptions.paths` into simple prefix → target mappings. */
export function parseTsAliases(tsconfig: string, baseDirDefault = ""): TsPathAlias[] {
  let parsed: {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  const stripped = stripJsonComments(tsconfig);
  try {
    parsed = JSON.parse(stripped);
  } catch {
    try {
      // tsconfig also tolerates trailing commas.
      parsed = JSON.parse(stripped.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return [];
    }
  }

  const options = parsed.compilerOptions ?? {};
  const base = normalize(`${baseDirDefault}/${options.baseUrl ?? "."}`);
  const aliases: TsPathAlias[] = [];

  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    aliases.push({
      prefix: pattern.replace(/\*$/, ""),
      targets: targets.map((target) => normalize(`${base}/${target.replace(/\*$/, "")}`)),
    });
  }
  return aliases;
}

/**
 * The resolver, together with the identity of everything it reads.
 *
 * Returned as one value on purpose. Skipping re-resolution is only sound while
 * the identity covers every input `resolve` consults, and the way that goes
 * wrong is for someone to teach the resolver a new input and not know there is
 * an identity to update. Building both here means adding a parameter to
 * `createResolver` without adding it below does not compile.
 *
 * Note what this is *not*: `sourceSignature` hashes each file's content, so it
 * moves on every edit and a gate built on it would never fire. What matters to
 * resolution is which paths exist and what the aliases say — not what is inside
 * them.
 */
export function resolutionInputs(
  filePaths: Iterable<string>,
  aliases: TsPathAlias[] = [],
): { resolver: Resolver; identity: string } {
  const paths = [...filePaths].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
  }
  hash.update("");
  for (const alias of [...aliases].sort((a, b) => a.prefix.localeCompare(b.prefix))) {
    hash.update(alias.prefix);
    hash.update("\0");
    hash.update([...alias.targets].sort().join(","));
    hash.update("\n");
  }
  return {
    resolver: createResolver(paths, aliases),
    identity: hash.digest("hex").slice(0, 16),
  };
}

export function createResolver(
  filePaths: Iterable<string>,
  aliases: TsPathAlias[] = [],
): Resolver {
  const files = new Set(filePaths);
  // Shortest-first so an ambiguous module resolves to the one nearest the root.
  const pythonFiles = [...files]
    .filter((path) => path.endsWith(".py"))
    .sort((a, b) => a.length - b.length);

  const tryFile = (candidate: string): string | null => {
    if (files.has(candidate)) return candidate;

    for (const [emitted, sources] of EMITTED_TO_SOURCE) {
      if (!emitted.test(candidate)) continue;
      for (const source of sources) {
        const rewritten = candidate.replace(emitted, source);
        if (files.has(rewritten)) return rewritten;
      }
    }

    for (const ext of TS_EXTENSIONS) {
      if (files.has(candidate + ext)) return candidate + ext;
    }
    for (const index of TS_INDEX) {
      if (files.has(candidate + index)) return candidate + index;
    }
    return null;
  };

  const tryPython = (candidate: string): string | null => {
    if (files.has(`${candidate}.py`)) return `${candidate}.py`;
    if (files.has(`${candidate}/__init__.py`)) return `${candidate}/__init__.py`;
    return null;
  };

  /**
   * Absolute imports in a src-layout or multi-package repo don't start at the
   * repo root — `langchain_google_genai.chat_models` lives at
   * `libs/genai/langchain_google_genai/chat_models.py`. Match on suffix.
   */
  const tryPythonPackage = (modulePath: string): string | null => {
    const file = `/${modulePath}.py`;
    const pkg = `/${modulePath}/__init__.py`;
    return (
      pythonFiles.find((path) => path.endsWith(file) || path.endsWith(pkg)) ?? null
    );
  };

  return {
    resolve(fromPath, specifier) {
      const isPython = fromPath.endsWith(".py") || fromPath.endsWith(".pyi");

      if (isPython) {
        // Relative: leading dots count levels up from the current package.
        const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
        if (dots > 0) {
          let base = dirOf(fromPath);
          for (let i = 1; i < dots; i++) base = dirOf(base);
          const rest = specifier.slice(dots).replace(/\./g, "/");
          const hit = tryPython(normalize(`${base}/${rest}`));
          return { dstPath: hit, external: hit ? null : null };
        }
        // Absolute dotted module — may still live in this repo.
        const asPath = specifier.replace(/\./g, "/");
        const hit =
          tryPython(asPath) ?? tryPython(`src/${asPath}`) ?? tryPythonPackage(asPath);
        if (hit) return { dstPath: hit, external: null };
        return { dstPath: null, external: packageName(specifier.split(".")[0]) };
      }

      if (specifier.startsWith(".")) {
        const hit = tryFile(normalize(`${dirOf(fromPath)}/${specifier}`));
        return { dstPath: hit, external: null };
      }

      for (const alias of aliases) {
        if (alias.prefix && specifier.startsWith(alias.prefix)) {
          const rest = specifier.slice(alias.prefix.length);
          for (const target of alias.targets) {
            const hit = tryFile(normalize(`${target}/${rest}`));
            if (hit) return { dstPath: hit, external: null };
          }
        }
      }

      // Bare specifier that happens to match a repo path (monorepo-style).
      const direct = tryFile(specifier) ?? tryFile(`src/${specifier}`);
      if (direct) return { dstPath: direct, external: null };

      return { dstPath: null, external: packageName(specifier) };
    },
  };
}
