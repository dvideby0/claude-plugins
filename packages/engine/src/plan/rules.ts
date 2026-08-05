/**
 * Review rules, served as an index rather than a wall of text.
 *
 * Guides are split into addressable sections. Context carries one line per
 * rule; an agent pulls the full text of the few it needs with audit_query.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Rule {
  id: string;
  guide: string;
  heading: string;
  summary: string;
  body: string;
}

const GUIDE_FOR_LANGUAGE: Record<string, string> = {
  typescript: "typescript",
  javascript: "typescript",
  python: "python",
};

/** Sections shorter than this are headings with no content of their own. */
const MIN_BODY_CHARS = 40;

function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function summarize(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
    if (!line || line.startsWith("#") || line.startsWith("|") || line.startsWith("```")) continue;
    return line.length > 110 ? `${line.slice(0, 110)}…` : line;
  }
  return "";
}

function parseGuide(guide: string, content: string): Rule[] {
  const rules: Rule[] = [];
  const lines = content.split("\n");

  let heading: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (!heading) return;
    const text = body.join("\n").trim();
    if (text.replace(/\s/g, "").length >= MIN_BODY_CHARS) {
      rules.push({
        id: `${guide}/${slug(heading)}`,
        guide,
        heading,
        summary: summarize(text),
        body: text,
      });
    }
    heading = null;
    body = [];
  };

  for (const line of lines) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[2];
      continue;
    }
    if (heading) body.push(line);
  }
  flush();

  return rules;
}

export function guidesForLanguages(languages: string[]): string[] {
  const guides = new Set<string>(["general"]);
  for (const language of languages) {
    const guide = GUIDE_FOR_LANGUAGE[language];
    if (guide) guides.add(guide);
  }
  return [...guides];
}

export async function loadRules(
  pluginRoot: string,
  languages?: string[],
): Promise<Rule[]> {
  const guides = languages
    ? guidesForLanguages(languages)
    : ["general", "typescript", "python"];

  const rules: Rule[] = [];
  for (const guide of guides) {
    try {
      const content = await readFile(join(pluginRoot, "lang", `${guide}.md`), "utf-8");
      rules.push(...parseGuide(guide, content));
    } catch {
      // A missing guide is not fatal.
    }
  }
  return rules;
}

export async function findRule(pluginRoot: string, id: string): Promise<Rule | null> {
  const rules = await loadRules(pluginRoot);
  return (
    rules.find((rule) => rule.id === id) ??
    rules.find((rule) => rule.id.endsWith(`/${id}`)) ??
    null
  );
}

export function renderRuleIndex(rules: Rule[]): string {
  return rules
    .map((rule) => `- \`${rule.id}\` — ${rule.heading}${rule.summary ? `: ${rule.summary}` : ""}`)
    .join("\n");
}
