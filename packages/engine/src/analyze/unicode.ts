/**
 * Unicode smuggling detection.
 *
 * Bidirectional controls can make displayed code differ from compiled code
 * (Trojan Source), and zero-width characters hide payloads inside identifiers,
 * strings and prompts. Neither has a legitimate use in source.
 *
 * Homoglyph detection is deliberately excluded — it cannot be separated from
 * legitimate non-ASCII text without a high false-positive rate.
 *
 * Every character below is written as an escape on purpose: literal copies
 * would make this file trip its own rules and be invisible to a reviewer.
 */

import type { FindingInput, Severity } from "../findings/types.js";
import type { SourceTextFile } from "../scan/source.js";

const BIDI_CODEPOINTS: Record<number, string> = {
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
};

const INVISIBLE_CODEPOINTS: Record<number, string> = {
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x2060: "WORD JOINER",
  0x180e: "MONGOLIAN VOWEL SEPARATOR",
  0x115f: "HANGUL CHOSEONG FILLER",
  0x1160: "HANGUL JUNGSEONG FILLER",
  0x3164: "HANGUL FILLER",
  0xffa0: "HALFWIDTH HANGUL FILLER",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE (BOM)",
};

function charClass(codepoints: Record<number, string>): RegExp {
  const escaped = Object.keys(codepoints)
    .map((code) => `\\u${Number(code).toString(16).padStart(4, "0")}`)
    .join("");
  return new RegExp(`[${escaped}]`, "u");
}

const BIDI = charClass(BIDI_CODEPOINTS);
const INVISIBLE = charClass(INVISIBLE_CODEPOINTS);

interface UnicodeRule {
  id: "bidi-control" | "invisible-character";
  pattern: RegExp;
  names: Record<number, string>;
  title: string;
  explanation: string;
}

const RULES: UnicodeRule[] = [
  {
    id: "bidi-control",
    pattern: BIDI,
    names: BIDI_CODEPOINTS,
    title: "Bidirectional control character in source",
    explanation:
      "Bidirectional controls can make the rendered source differ from what the compiler sees.",
  },
  {
    id: "invisible-character",
    pattern: INVISIBLE,
    names: INVISIBLE_CODEPOINTS,
    title: "Invisible character in source",
    explanation:
      "Invisible characters have no legitimate use in source and are used to hide payloads.",
  },
];

/** Name every offending codepoint on a line, e.g. "U+202E RIGHT-TO-LEFT OVERRIDE". */
function describe(line: string, names: Record<number, string>): string {
  const found = new Set<string>();
  for (const char of line) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    const name = names[code];
    if (name) {
      found.add(`U+${code.toString(16).toUpperCase().padStart(4, "0")} ${name}`);
    }
  }
  return [...found].join(", ");
}

function stripControls(line: string): string {
  return line.replace(new RegExp(BIDI.source, "gu"), "").replace(
    new RegExp(INVISIBLE.source, "gu"),
    "",
  );
}

function severityFor(rule: UnicodeRule, file: SourceTextFile): Severity {
  if (rule.id === "bidi-control") return "critical";
  return file.lang === "docs" ? "medium" : "high";
}

export function scanUnicode(files: SourceTextFile[]): FindingInput[] {
  const findings: FindingInput[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // A BOM at the very start of the file is legitimate.
      const candidate = i === 0 ? line.replace(/^\uFEFF/, "") : line;

      for (const rule of RULES) {
        if (!rule.pattern.test(candidate)) continue;

        findings.push({
          ruleId: `unicode/${rule.id}`,
          category: "security",
          severity: severityFor(rule, file),
          confidence: "definite",
          source: "secrets",
          title: rule.title,
          description: `${describe(candidate, rule.names)} at ${file.path}:${i + 1}. ${rule.explanation}`,
          suggestion:
            "Remove the character, or use an explicit escape if it is genuinely required inside a string literal.",
          path: file.path,
          lineStart: i + 1,
          lineEnd: i + 1,
          // Strip the offending characters so the fingerprint survives edits
          // to the surrounding line.
          snippet: stripControls(candidate).trim().slice(0, 200),
          symbol: rule.id,
        });
      }
    }
  }

  return findings;
}
