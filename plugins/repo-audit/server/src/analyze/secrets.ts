/**
 * In-process secret scanning. No external binary, no regex shelling out.
 */

import type { FindingInput, Severity } from "../findings/types.js";
import type { ScannedFile } from "../scan/walk.js";

interface SecretRule {
  id: string;
  pattern: RegExp;
  title: string;
  severity: Severity;
}

const RULES: SecretRule[] = [
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    title: "AWS access key ID committed to source",
    severity: "critical",
  },
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    title: "Private key committed to source",
    severity: "critical",
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    title: "GitHub token committed to source",
    severity: "critical",
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    title: "Slack token committed to source",
    severity: "critical",
  },
  {
    id: "connection-string-password",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s"']+:[^@\s"']+@/,
    title: "Connection string with inline password",
    severity: "high",
  },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/,
    title: "Hardcoded JWT",
    severity: "high",
  },
  {
    id: "hardcoded-credential",
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\n]{8,}["']/i,
    title: "Hardcoded credential assignment",
    severity: "high",
  },
];

/** Values that look like documentation or an env lookup rather than a secret. */
const PLACEHOLDER =
  /(example|sample|dummy|changeme|placeholder|redacted|fake|xxx+|\*{3,}|<[^>]*>|\$\{|process\.env|os\.environ|getenv|\byour[_-]|\bmy[_-]|\btest[_-]|\bnone\b|\bnull\b|\bundefined\b)/i;

export function scanSecrets(files: ScannedFile[]): FindingInput[] {
  const findings: FindingInput[] = [];

  for (const file of files) {
    if (file.lang === "docs") continue;
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 500) continue;

      for (const rule of RULES) {
        const match = rule.pattern.exec(line);
        if (!match) continue;
        if (PLACEHOLDER.test(match[0])) continue;

        findings.push({
          ruleId: `secrets/${rule.id}`,
          category: "security",
          severity: file.isTest ? "medium" : rule.severity,
          confidence: rule.id === "hardcoded-credential" ? "medium" : "high",
          source: "secrets",
          title: rule.title,
          description: `${rule.title} in ${file.path}:${i + 1}.${
            file.isTest ? " File looks like a test — verify before treating as live." : ""
          }`,
          suggestion: "Move the value to an environment variable or secret manager and rotate it.",
          path: file.path,
          lineStart: i + 1,
          lineEnd: i + 1,
          snippet: line.trim().slice(0, 200),
          symbol: rule.id,
        });
      }
    }
  }

  return findings;
}
