/**
 * A briefing for whoever is about to do the work.
 *
 * The usual way to give a subagent context is to hand it files and hope it
 * reads the right parts. That spends most of a context window before any work
 * starts, and still misses the things files do not say: what depends on this,
 * what is already known to be broken, what was decided last time.
 *
 * This assembles that as a query instead — deterministic, ordered by what
 * matters, and cut to a budget. Constraints come first because they are the
 * cheapest thing to get wrong.
 */

import type { Db } from "../db/db.js";
import { neighbourhood } from "../memory/context.js";
import { recall } from "../memory/store.js";
import { impactOf } from "./refs.js";

export interface BriefOptions {
  /** What the work is. Used to pull relevant memories the target misses. */
  task?: string;
  /** Rough character budget. Sections are dropped from the bottom up. */
  budget?: number;
}

export interface Brief {
  target: string;
  resolved: string | null;
  /** Ready to paste into a subagent prompt. */
  text: string;
  /** Files worth opening, in order. Saves the subagent a search. */
  readFirst: string[];
  characters: number;
  omitted: string[];
}

const HEADING = (title: string): string => `## ${title}`;

/**
 * Reference resolution is import-based, so it sees `foo()` imported from a
 * module and misses `obj.foo()` and `x: SomeType`. Reporting those as unused
 * would be worse than saying nothing — someone deletes live code on the
 * strength of it — so they are labelled as untracked instead.
 */
const UNTRACKED_KINDS = new Set(["method", "type", "interface", "enum"]);

function usage(
  symbol: { kind: string; references: number },
  referenceCoverage: "none" | "import" | "typed",
): string {
  if (symbol.references > 0) {
    return `${symbol.references} use${symbol.references === 1 ? "" : "s"}`;
  }
  if (referenceCoverage === "none") return "uses unknown — reference analysis unavailable";
  return UNTRACKED_KINDS.has(symbol.kind) ? "uses not tracked" : "unused elsewhere";
}

function UNRESOLVED_NOTE(
  symbols: Array<{ kind: string }>,
  referenceCoverage: "none" | "import" | "typed",
): string {
  if (referenceCoverage === "none") {
    return "\n_Reference analysis was unavailable for this file. Treat every zero as unknown; do not infer that code is unused or untested._";
  }
  return symbols.some((symbol) => UNTRACKED_KINDS.has(symbol.kind))
    ? "\n_Method calls and type positions are not resolved; treat “uses not tracked” as unknown, not zero._"
    : "";
}

export function buildBrief(db: Db, target: string, options: BriefOptions = {}): Brief {
  const budget = options.budget ?? 6000;
  const view = neighbourhood(db, target, 30);

  if (!view.resolved) {
    return {
      target,
      resolved: null,
      text: `No indexed file or symbol matches "${target}". The repository may not be indexed yet.`,
      readFirst: [],
      characters: 0,
      omitted: [],
    };
  }

  const impact = impactOf(db, view.resolved, 40);
  const sections: Array<{ name: string; text: string; essential?: boolean }> = [];

  // --- what it is ----------------------------------------------------------
  const file = view.file;
  sections.push({
    name: "identity",
    essential: true,
    text: [
      `# ${view.resolved}`,
      file
        ? `${file.lang} · ${file.loc} lines · churn ${file.churn}${file.isTest ? " · test file" : ""}`
        : "",
      view.candidates?.length
        ? `\n> "${target}" also matches: ${view.candidates.slice(1, 5).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  // --- constraints first ---------------------------------------------------
  // Anything recorded as a rule outranks everything else here: breaking one is
  // the most expensive mistake available and the least visible in the code.
  const isRule = (kind: string): boolean =>
    ["constraint", "decision", "gotcha"].includes(kind);

  // Notes recorded against this file come first. Notes inherited from a
  // dependency are worth seeing but are not rules about the code being
  // changed, and putting them level with the rest buries the ones that are.
  const own = view.memories.filter((memory) => isRule(memory.kind));
  const inherited = view.nearbyMemories.filter((memory) => isRule(memory.kind));
  const rules = [...own, ...inherited];
  const fromTask = options.task
    ? recall(db, options.task, 6).filter(
        (memory) => !rules.some((existing) => existing.id === memory.id),
      )
    : [];

  if (rules.length + fromTask.length > 0) {
    sections.push({
      name: "constraints",
      essential: true,
      text: [
        HEADING("What constrains this"),
        ...[...rules, ...fromTask].map((memory) => {
          const stale = memory.anchors.some((anchor) => anchor.stale);
          const borrowed = inherited.some((other) => other.id === memory.id);
          const where = memory.anchors
            .map((anchor) => anchor.path + (anchor.symbol ? `#${anchor.symbol}` : ""))
            .join(", ");
          return [
            `- ${borrowed ? "" : "**"}${memory.kind}: ${memory.title}${borrowed ? "" : "**"}` +
              (stale ? " ⚠ recorded against an older version — verify" : "") +
              (borrowed ? " _(from a dependency, not this file)_" : ""),
            memory.body ? `  ${memory.body}` : "",
            where ? `  _(${where})_` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }),
      ].join("\n"),
    });
  }

  // --- what it exposes -----------------------------------------------------
  const exported = view.symbols.filter((symbol) => symbol.exported);
  if (exported.length > 0) {
    sections.push({
      name: "surface",
      essential: true,
      text: [
        HEADING("What it exposes"),
        ...exported.slice(0, 20).map((symbol) => {
          const line = `- \`${symbol.name}\` (${symbol.kind}, line ${symbol.startLine}) — ${usage(
            symbol,
            file?.referenceCoverage ?? "none",
          )}`;
          const withNotes = symbol.notes > 0 ? `${line} · ${symbol.notes} note(s) recorded` : line;
          // The declaration of an exported constant carries the allowed values.
          // Showing them is what stops a caller inventing one that is not in
          // the union — the single most common avoidable mistake here.
          return symbol.kind === "constant" && symbol.signature
            ? `${withNotes}\n    \`${symbol.signature}\``
            : withNotes;
        }),
        UNRESOLVED_NOTE(exported, file?.referenceCoverage ?? "none"),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  // --- blast radius --------------------------------------------------------
  sections.push({
    name: "impact",
    essential: true,
    text: [
      HEADING("If you change it"),
      impact.referenceCoverage === "none"
        ? `${impact.directImporters} file(s) import this; precise references are unknown because reference analysis was unavailable.`
        : `${impact.directImporters} file(s) import this; ${impact.totalReferences} reference(s) from elsewhere resolve to it` +
          (impact.internalReferences > 0
            ? ` (plus ${impact.internalReferences} within the file itself, which nobody else depends on).`
            : "."),
      impact.referenceCoverage === "none"
        ? "Affected call sites are unknown. Use the importers as the conservative blast radius."
        : impact.affectedFiles.length
          ? `Affected: ${impact.affectedFiles.slice(0, 12).join(", ")}${
              impact.affectedFiles.length > 12 ? `, +${impact.affectedFiles.length - 12} more` : ""
            }`
          : "No tracked references found.",
      impact.referenceCoverage === "none"
        ? "Test coverage is unknown because reference analysis was unavailable."
        : impact.coveringTests.length
          ? `Covered by: ${impact.coveringTests.join(", ")}`
          : "**No tracked test reference covers it.** Add or verify one before changing behaviour.",
    ].join("\n"),
  });

  // --- known problems ------------------------------------------------------
  if (view.findings.length > 0) {
    sections.push({
      name: "findings",
      text: [
        HEADING("Already known to be wrong here"),
        ...view.findings
          .slice(0, 10)
          .map(
            (finding) =>
              `- [${finding.severity}] ${finding.title}${finding.line ? ` (line ${finding.line})` : ""}` +
              (finding.suggestion ? `\n  suggested: ${finding.suggestion}` : ""),
          ),
      ].join("\n"),
    });
  }

  // --- neighbourhood -------------------------------------------------------
  if (view.imports.length || view.externals.length) {
    sections.push({
      name: "depends-on",
      text: [
        HEADING("It depends on"),
        view.imports.length ? `Local: ${view.imports.slice(0, 12).join(", ")}` : "",
        view.externals.length ? `Packages: ${view.externals.slice(0, 12).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  // Background notes are the first thing dropped when the budget is tight.
  const background = [...view.memories, ...view.nearbyMemories].filter(
    (memory) => !["constraint", "decision", "gotcha"].includes(memory.kind),
  );
  if (background.length > 0) {
    sections.push({
      name: "background",
      text: [
        HEADING("Background"),
        ...background.map((memory) => `- ${memory.kind}: ${memory.title}`),
      ].join("\n"),
    });
  }

  // --- pack to budget ------------------------------------------------------
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const section of sections) {
    if (used + section.text.length > budget && !section.essential) {
      omitted.push(section.name);
      continue;
    }
    kept.push(section.text);
    used += section.text.length;
  }

  // Deduplicated: the target is usually also in affectedFiles, and sending a
  // subagent to read the same file twice is exactly the waste this avoids.
  const readFirst = [
    ...new Set([
      view.resolved,
      ...impact.coveringTests.slice(0, 2),
      ...impact.affectedFiles.filter((path) => !impact.coveringTests.includes(path)).slice(0, 3),
    ]),
  ];

  const text = kept.join("\n\n");
  return {
    target,
    resolved: view.resolved,
    text,
    readFirst,
    characters: text.length,
    omitted,
  };
}
