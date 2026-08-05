/**
 * Search by code shape.
 *
 * A regex finds the word `catch` and cannot tell an empty handler from a
 * careful one. A tree-sitter query matches the parsed structure, so "every
 * place we swallow an error" becomes a question with an exact answer rather
 * than a grep and a lot of reading. This is the capability Sourcegraph calls
 * structural search, and the parser to do it was already here.
 *
 * Raw queries are available, but nobody wants to write S-expressions to answer
 * a common question, so the patterns worth asking repeatedly are named.
 */

import { loadNative } from "../scan/source.js";

export interface Pattern {
  name: string;
  description: string;
  /** Why the result is worth looking at, not just what it matches. */
  why: string;
  languages: string[];
  query: string;
}

export const PATTERNS: Pattern[] = [
  {
    name: "swallowed-errors",
    description: "catch blocks that do nothing with the error",
    why: "The failure is invisible at runtime: no log, no rethrow, no handling.",
    languages: ["typescript", "javascript"],
    query: '((catch_clause body: (statement_block) @body) (#match? @body "^\\\\{\\\\s*\\\\}$"))',
  },
  {
    name: "async-functions",
    description: "async function declarations",
    why: "Where the concurrency is, and where unawaited promises hide.",
    languages: ["typescript", "javascript"],
    query: '(function_declaration "async") @fn',
  },
  {
    name: "any-annotations",
    description: "explicit `any` in a type position",
    why: "Each one is a hole in the type coverage, and they spread outward.",
    languages: ["typescript"],
    query: '((predefined_type) @type (#eq? @type "any"))',
  },
  {
    name: "throws",
    description: "throw statements",
    why: "The error paths, which are usually the least tested part of a module.",
    languages: ["typescript", "javascript"],
    query: "(throw_statement) @throw",
  },
  {
    name: "todo-comments",
    description: "TODO, FIXME, or XXX comments in the code",
    why: "Deferred work that never made it into anything trackable.",
    languages: ["typescript", "javascript", "python"],
    query: '((comment) @comment (#match? @comment "(?i)\\\\b(?:TODO|FIXME|XXX)\\\\b"))',
  },
  {
    name: "python-bare-except",
    description: "bare except clauses",
    why: "A bare `except:` catches SystemExit and KeyboardInterrupt too.",
    languages: ["python"],
    query: '((except_clause) @except (#match? @except "^except\\\\s*:\\\\s*(?:\\\\n|$)"))',
  },
  {
    name: "python-asserts",
    description: "assert statements",
    why: "Assertions are removed under `python -O`, so any that guard real behaviour are a bug.",
    languages: ["python"],
    query: "(assert_statement) @assert",
  },
];

export interface StructuralMatch {
  path: string;
  line: number;
  endLine: number;
  text: string;
  capture: string;
}

export interface StructuralResult {
  query: string;
  pattern: string | null;
  why: string | null;
  matches: StructuralMatch[];
  total: number;
  /** Files grouped, since "where is this concentrated" is the usual question. */
  byFile: Array<{ path: string; count: number }>;
  available: boolean;
}

interface NativeSearch {
  searchStructural(
    root: string,
    query: string,
    languages?: string[] | undefined,
    limit?: number | undefined,
    text?: string | undefined,
  ): Promise<StructuralMatch[]>;
}

/**
 * A `text` filter applies after the structural match.
 *
 * Shape gets you to every catch block; the interesting subset is usually
 * defined by content — an empty body, a specific call. Combining the two beats
 * either alone, and tree-sitter queries cannot express "body is empty".
 */
export async function structuralSearch(
  projectRoot: string,
  options: { query?: string; pattern?: string; languages?: string[]; limit?: number; text?: string },
): Promise<StructuralResult> {
  const native = loadNative() as unknown as NativeSearch | null;

  const known = options.pattern
    ? PATTERNS.find((entry) => entry.name === options.pattern)
    : undefined;
  if (options.pattern && !known) {
    throw new Error(
      `Unknown pattern "${options.pattern}". Available: ${PATTERNS.map((p) => p.name).join(", ")}`,
    );
  }

  const query = known?.query ?? options.query;
  if (!query) throw new Error("Provide either a pattern name or a tree-sitter query.");

  if (!native?.searchStructural) {
    return {
      query,
      pattern: known?.name ?? null,
      why: known?.why ?? null,
      matches: [],
      total: 0,
      byFile: [],
      available: false,
    };
  }

  const matches = await native.searchStructural(
    projectRoot,
    query,
    options.languages ?? known?.languages,
    Math.min(options.limit ?? 200, 1000),
    options.text,
  );

  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);

  return {
    query,
    pattern: known?.name ?? null,
    why: known?.why ?? null,
    matches,
    total: matches.length,
    byFile: [...counts.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count),
    available: true,
  };
}
