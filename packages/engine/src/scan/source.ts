/**
 * Where scanned files come from.
 *
 * The native core walks and parses the whole repository on every core at once;
 * the TypeScript path does it one file at a time. Both produce the same rows —
 * that is checked by scripts/bench.mjs — so this picks the fast one when it is
 * present and falls back cleanly when it is not.
 *
 * Set SDLC_NATIVE=0 to force the TypeScript path.
 */

import { createRequire } from "node:module";
import type { ParseResult } from "./parse.js";
import { isNoise, walk, type Lang } from "./walk.js";

/** A use of an imported name, before the specifier is resolved to a file. */
export interface SourceRef {
  name: string;
  module: string;
  line: number;
}

export interface SourceFile {
  path: string;
  lang: Lang;
  loc: number;
  bytes: number;
  contentSha: string;
  isTest: boolean;
  /** Present only on the TypeScript path, where parsing happens later. */
  content: string | null;
  /** Present only on the native path, where parsing already happened. */
  parsed: ParseResult | null;
  /** Uses of imported names. Native path only — see collectFiles. */
  refs: SourceRef[];
}

interface NativeFile {
  path: string;
  lang: string;
  loc: number;
  bytes: number;
  contentSha: string;
  isTest: boolean;
  parsed: boolean;
  symbols: Array<{
    kind: string;
    name: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    defaultExport: boolean;
    signature: string;
  }>;
  imports: string[];
  refs: Array<{ name: string; module: string; line: number }>;
}

interface NativeCore {
  scanRepo(root: string): Promise<{ files: NativeFile[]; walkMs: number; parseMs: number }>;
}

let nativeLookedUp = false;
let native: NativeCore | null = null;

/** Resolve the native core once. A missing binary is not an error. */
export function loadNative(): NativeCore | null {
  if (nativeLookedUp) return native;
  nativeLookedUp = true;

  if (process.env.SDLC_NATIVE === "0") return null;
  try {
    const require = createRequire(import.meta.url);
    native = require("@sdlc/scan-core") as NativeCore;
  } catch {
    native = null;
  }
  return native;
}

export interface CollectResult {
  files: SourceFile[];
  engine: "native" | "typescript";
  walkMs: number;
  parseMs: number;
}

export async function collectFiles(projectRoot: string): Promise<CollectResult> {
  const core = loadNative();

  if (core) {
    const result = await core.scanRepo(projectRoot);
    return {
      engine: "native",
      walkMs: result.walkMs,
      parseMs: result.parseMs,
      files: result.files.map((file) => ({
        path: file.path,
        lang: file.lang as Lang,
        loc: file.loc,
        bytes: file.bytes,
        contentSha: file.contentSha,
        isTest: file.isTest,
        content: null,
        // Noise is walked and recorded but never parsed, on either path.
        parsed:
          file.parsed && !isNoise(file.path)
            ? { symbols: file.symbols as ParseResult["symbols"], imports: file.imports }
            : null,
        refs: file.parsed && !isNoise(file.path) ? file.refs : [],
      })),
    };
  }

  const started = Date.now();
  const walked = await walk(projectRoot);
  return {
    engine: "typescript",
    walkMs: Date.now() - started,
    parseMs: 0,
    files: walked.map((file) => ({
      path: file.path,
      lang: file.lang,
      loc: file.loc,
      bytes: file.bytes,
      contentSha: file.contentSha,
      isTest: file.isTest,
      content: file.content,
      parsed: null,
      // Reference extraction lives in the native core only; without it the
      // graph still works, symbol-level queries simply return nothing.
      refs: [],
    })),
  };
}
