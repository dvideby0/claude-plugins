/**
 * Context assembly.
 *
 * Context is a query against the store, packed to a budget in priority order:
 * rules, known findings, graph neighbourhood, then source. Agents are told
 * what is already known so they don't re-report it, and can pull more through
 * audit_query instead of having everything pushed at them.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/db.js";
import type { WorkUnit } from "./risk.js";

export interface ContextResult {
  unitId: string;
  prompt: string;
  estimatedTokens: number;
  filesIncluded: number;
  filesOmitted: string[];
  knownFindings: number;
}

const GUIDES: Record<string, string> = {
  typescript: "typescript.md",
  javascript: "typescript.md",
  python: "python.md",
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function readGuides(pluginRoot: string, languages: string[]): Promise<string> {
  const names = new Set(languages.map((lang) => GUIDES[lang]).filter(Boolean));
  names.add("general.md");

  const parts: string[] = [];
  for (const name of names) {
    try {
      parts.push(await readFile(join(pluginRoot, "lang", name), "utf-8"));
    } catch {
      // A missing guide is not fatal.
    }
  }
  return parts.join("\n\n");
}

function knownFindingsBlock(db: Db, paths: string[]): { text: string; count: number } {
  const placeholders = paths.map(() => "?").join(",");
  const rows = db.all<{
    id: string;
    rule_id: string;
    severity: string;
    path: string;
    line_start: number | null;
    title: string;
  }>(
    `SELECT id, rule_id, severity, path, line_start, title
       FROM findings
      WHERE status IN ('open','regressed') AND path IN (${placeholders})
      ORDER BY severity, path`,
    paths,
  );

  if (rows.length === 0) {
    return { text: "None recorded for these files yet.", count: 0 };
  }

  const lines = rows.map(
    (row) =>
      `- [${row.severity}] ${row.path}:${row.line_start ?? "?"} ${row.rule_id} — ${row.title}`,
  );
  return { text: lines.join("\n"), count: rows.length };
}

function graphBlock(db: Db, paths: string[]): string {
  const placeholders = paths.map(() => "?").join(",");

  const importers = db.all<{ dst_path: string; src_path: string }>(
    `SELECT dst_path, src_path FROM edges
      WHERE dst_path IN (${placeholders}) ORDER BY dst_path, src_path`,
    paths,
  );
  const imports = db.all<{ src_path: string; dst_path: string | null; external: string | null }>(
    `SELECT src_path, dst_path, external FROM edges
      WHERE src_path IN (${placeholders}) ORDER BY src_path`,
    paths,
  );

  const dependencyPaths = [
    ...new Set(imports.map((edge) => edge.dst_path).filter((p): p is string => Boolean(p))),
  ].filter((path) => !paths.includes(path));

  const signatures = dependencyPaths.length
    ? db.all<{ path: string; kind: string; name: string; signature: string }>(
        `SELECT path, kind, name, signature FROM symbols
          WHERE exported = 1 AND path IN (${dependencyPaths.map(() => "?").join(",")})
          ORDER BY path, name LIMIT 200`,
        dependencyPaths,
      )
    : [];

  const lines: string[] = [];

  const importerMap = new Map<string, string[]>();
  for (const edge of importers) {
    const list = importerMap.get(edge.dst_path) ?? [];
    list.push(edge.src_path);
    importerMap.set(edge.dst_path, list);
  }
  if (importerMap.size > 0) {
    lines.push("Who depends on these files (blast radius of a change):");
    for (const [path, sources] of importerMap) {
      lines.push(`- ${path} ← ${sources.slice(0, 12).join(", ")}${sources.length > 12 ? ", …" : ""}`);
    }
    lines.push("");
  }

  const externals = [...new Set(imports.map((edge) => edge.external).filter(Boolean))];
  if (externals.length > 0) {
    lines.push(`External packages used: ${externals.join(", ")}`);
    lines.push("");
  }

  if (signatures.length > 0) {
    lines.push("Exported signatures of what these files import (do not re-read these files):");
    let current = "";
    for (const symbol of signatures) {
      if (symbol.path !== current) {
        current = symbol.path;
        lines.push(`  ${current}`);
      }
      lines.push(`    ${symbol.kind} ${symbol.name} — ${symbol.signature}`);
    }
  }

  return lines.join("\n");
}

const INSTRUCTIONS = `
## What to report

Report only what needs human judgment: semantic bugs, unsafe assumptions,
missing error handling, security-relevant logic, contract mismatches between
callers and callees, tests that assert nothing meaningful, and structural
problems the graph above makes visible.

Do NOT report anything already listed under KNOWN FINDINGS — linters and type
checkers have already covered that ground. Do not report style preferences.

## How to report

Call audit_record_findings once with every finding you are confident in. Each
finding needs: ruleId (stable slug, e.g. "llm/unchecked-nullable"), category,
severity, confidence, path, lineStart, title, description, suggestion.

Anything you assert must be visible in the code you were given. If you need
more context, call audit_query (kinds: symbol, importers, imports, findings,
hotspots) rather than guessing.
`.trim();

export async function buildContext(
  db: Db,
  unit: WorkUnit,
  options: { projectRoot: string; pluginRoot: string; tokenBudget?: number },
): Promise<ContextResult> {
  const budget = options.tokenBudget ?? 60_000;
  const sections: string[] = [];
  let used = 0;

  const header = [
    `# Review unit ${unit.id}`,
    ``,
    `Files: ${unit.paths.join(", ")}`,
    `Languages: ${unit.languages.join(", ")}`,
    `Selected because: ${unit.reason} (risk ${unit.risk})`,
  ].join("\n");
  sections.push(header);
  used += estimateTokens(header);

  const guides = await readGuides(options.pluginRoot, unit.languages);
  if (guides) {
    const block = `## REVIEW RULES\n\n${guides}`;
    sections.push(block);
    used += estimateTokens(block);
  }

  const known = knownFindingsBlock(db, unit.paths);
  const knownBlock = `## KNOWN FINDINGS (already reported — do not repeat)\n\n${known.text}`;
  sections.push(knownBlock);
  used += estimateTokens(knownBlock);

  const graph = graphBlock(db, unit.paths);
  if (graph) {
    const block = `## GRAPH CONTEXT\n\n${graph}`;
    sections.push(block);
    used += estimateTokens(block);
  }

  const sourceParts: string[] = [];
  const omitted: string[] = [];
  let included = 0;

  for (const path of unit.paths) {
    let content: string;
    try {
      content = await readFile(join(options.projectRoot, path), "utf-8");
    } catch {
      omitted.push(path);
      continue;
    }

    const lines = content.split("\n");
    const body =
      lines.length > 800
        ? `${lines.slice(0, 500).join("\n")}\n\n… ${lines.length - 700} lines omitted …\n\n${lines
            .slice(-200)
            .join("\n")}`
        : content;

    const numbered = body
      .split("\n")
      .map((line, index) => `${String(index + 1).padStart(4)} | ${line}`)
      .join("\n");
    const block = `### ${path}\n\n\`\`\`\n${numbered}\n\`\`\``;
    const cost = estimateTokens(block);

    if (used + cost > budget) {
      omitted.push(path);
      continue;
    }
    sourceParts.push(block);
    used += cost;
    included++;
  }

  sections.push(`## SOURCE\n\n${sourceParts.join("\n\n")}`);
  if (omitted.length > 0) {
    const note = `Not included (budget): ${omitted.join(", ")}. Use Read if you need them.`;
    sections.push(note);
    used += estimateTokens(note);
  }

  sections.push(INSTRUCTIONS);
  used += estimateTokens(INSTRUCTIONS);

  const prompt = sections.join("\n\n");
  return {
    unitId: unit.id,
    prompt,
    estimatedTokens: estimateTokens(prompt),
    filesIncluded: included,
    filesOmitted: omitted,
    knownFindings: known.count,
  };
}
