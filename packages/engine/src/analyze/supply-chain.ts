/**
 * Supply-chain and agent-configuration auditing.
 *
 * Advisory databases cover known vulnerabilities in declared dependencies.
 * They say nothing about the ways a repository can execute code on the
 * machine of whoever clones it: install hooks, CI workflows, and — now that
 * repos ship agent configuration — hooks and MCP servers that run on open.
 *
 * These are structural heuristics, not a denylist of known-bad artefacts,
 * because a hardcoded incident list is stale the week after it is written.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FindingInput } from "../findings/types.js";
import type { SourceTextFile } from "../scan/source.js";

/** Shell fragments that turn a config value into remote code execution. */
const DANGEROUS_COMMAND: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(?:curl|wget)\b[^|;&]*[|]\s*(?:ba|z|k)?sh\b/i, why: "downloads and pipes a script straight into a shell" },
  { pattern: /\bbase64\s+(?:-d|--decode|-D)\b/i, why: "decodes base64 before executing it" },
  { pattern: /\b(?:atob|Buffer\.from)\s*\([^)]*base64/i, why: "decodes base64 before executing it" },
  { pattern: /\bnc\b\s+-[a-z]*e/i, why: "opens a netcat reverse shell" },
  { pattern: /\beval\b\s*[("'$]/i, why: "evaluates a dynamically built string" },
  { pattern: /\bpython3?\s+-c\b/i, why: "executes an inline python program" },
  { pattern: /\bnode\s+-e\b/i, why: "executes an inline node program" },
  { pattern: /[|;&]\s*(?:ba|z|k)?sh\s+-c\b/i, why: "chains into a shell" },
];

/** Agent and editor configuration that can execute on open or on tool use. */
const AGENT_CONFIG_FILES = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks.json",
  ".mcp.json",
  ".cursor/mcp.json",
  ".cursor/environment.json",
  ".vscode/tasks.json",
  ".opencode/config.json",
  ".codex/config.toml",
];

/** Permission grants broad enough that any later review is meaningless. */
// A bare `Bash` entry (no parentheses) is the broadest grant of all; the
// command names need a boundary so `Bash(shasum …)` does not read as `sh`.
const BROAD_PERMISSION =
  /^(?:Bash|Shell)$|^(?:Bash|Shell)\(\s*(?:\*|:\*)?\s*\)$|^Bash\((?:curl|wget|sh|bash|eval)(?:[\s:)]|$)/i;

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

interface JsonLeaf {
  path: string[];
  value: string;
  line?: number;
}

/** Walk a parsed JSON document and yield every string leaf with its key path. */
function stringLeaves(value: unknown, path: string[] = [], out: JsonLeaf[] = []): JsonLeaf[] {
  if (typeof value === "string") {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => stringLeaves(item, [...path, String(index)], out));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      stringLeaves(child, [...path, key], out);
    }
  }
  return out;
}

/** Remove a TOML comment without treating a # inside a quoted value as one. */
function stripTomlComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null) return line.slice(0, index);
  }
  return line;
}

function tomlValueComplete(value: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (const char of value) {
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (quote) continue;
    if (char === "[") square++;
    else if (char === "]") square--;
    else if (char === "{") curly++;
    else if (char === "}") curly--;
  }
  return quote === null && square <= 0 && curly <= 0;
}

/**
 * Extract string values from the TOML subset Codex uses for MCP servers.
 * Tables and dotted keys become the same key path JSON traversal produces;
 * arrays and inline tables may span lines. We do not need to interpret
 * numbers or dates because only executable string values are security inputs.
 */
function tomlStringLeaves(content: string): JsonLeaf[] {
  const leaves: JsonLeaf[] = [];
  const lines = content.split("\n");
  let section: string[] = [];
  let pending: { path: string[]; value: string; line: number } | null = null;

  const emit = (path: string[], value: string, line: number): void => {
    const pattern = /"(?:\\.|[^"\\])*"|'[^']*'/g;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = pattern.exec(value)) !== null) {
      const literal = match[0];
      let decoded = literal.slice(1, -1);
      if (literal.startsWith('"')) {
        try {
          decoded = JSON.parse(literal) as string;
        } catch {
          // Keep the raw string body; dangerous command tokens remain visible.
        }
      }
      const lineOffset = value.slice(0, match.index).split("\n").length - 1;
      leaves.push({ path: [...path, String(index++)], value: decoded, line: line + lineOffset });
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const clean = stripTomlComment(lines[index] as string).trim();
    if (!clean) continue;

    if (pending) {
      pending.value += `\n${clean}`;
      if (tomlValueComplete(pending.value)) {
        emit(pending.path, pending.value, pending.line);
        pending = null;
      }
      continue;
    }

    const table = /^\[\[?([^\]]+)\]\]?$/.exec(clean);
    if (table) {
      section = (table[1] as string)
        .split(".")
        .map((part) => part.trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(clean);
    if (!assignment) continue;
    const path = [...section, ...(assignment[1] as string).split(".")];
    const value = assignment[2] as string;
    if (tomlValueComplete(value)) emit(path, value, index + 1);
    else pending = { path, value, line: index + 1 };
  }

  if (pending) emit(pending.path, pending.value, pending.line);
  return leaves;
}

/**
 * A value sitting under a deny/block key is a rule *against* the dangerous
 * thing, not a use of it. Borrowed from ECC's supply-chain scanner, which
 * skips indicators found inside permission deny ranges.
 */
function isDenyContext(path: string[]): boolean {
  return path.some((segment) => /^(deny|denied|block|blocked|blocklist|ignore|exclude)$/i.test(segment));
}

function dangerousReason(command: string): string | null {
  for (const { pattern, why } of DANGEROUS_COMMAND) {
    if (pattern.test(command)) return why;
  }
  return null;
}

function lineOf(content: string, needle: string): number | undefined {
  const index = content.indexOf(needle);
  if (index === -1) return undefined;
  return content.slice(0, index).split("\n").length;
}

// --- package.json install hooks --------------------------------------------

function checkInstallScripts(files: SourceTextFile[]): FindingInput[] {
  const findings: FindingInput[] = [];

  for (const file of files) {
    if (!file.path.endsWith("package.json")) continue;

    let parsed: { scripts?: Record<string, string> };
    try {
      parsed = JSON.parse(file.content);
    } catch {
      continue;
    }

    for (const hook of INSTALL_HOOKS) {
      const script = parsed.scripts?.[hook];
      if (!script) continue;
      const reason = dangerousReason(script);
      if (!reason) continue;

      findings.push({
        ruleId: "supply-chain/install-script-execution",
        category: "security",
        severity: "critical",
        confidence: "high",
        source: "deps",
        title: `${hook} script ${reason}`,
        description: `${file.path} runs on \`npm install\` before any code is reviewed. Its ${hook} script ${reason}: ${script.slice(0, 200)}`,
        suggestion: `Move the work out of ${hook} into an explicit, reviewable command.`,
        path: file.path,
        lineStart: lineOf(file.content, `"${hook}"`),
        snippet: script.slice(0, 200),
        symbol: hook,
      });
    }
  }

  return findings;
}

// --- obfuscated payloads in source -----------------------------------------

const OBFUSCATED: Array<{ pattern: RegExp; title: string }> = [
  {
    pattern: /\beval\s*\(\s*(?:atob|Buffer\.from|decodeURIComponent)\s*\(/,
    title: "Decoded string passed straight to eval",
  },
  {
    pattern: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*(?:atob|Buffer\.from)\s*\(/,
    title: "Decoded string executed as a shell command",
  },
  {
    pattern: /\b(?:exec|eval)\s*\(\s*(?:base64\.b64decode|codecs\.decode)\s*\(/,
    title: "Decoded string executed in python",
  },
  {
    pattern: /["'][A-Za-z0-9+/]{240,}={0,2}["']/,
    title: "Very long base64 literal embedded in source",
  },
];

function checkObfuscatedPayloads(files: SourceTextFile[]): FindingInput[] {
  const findings: FindingInput[] = [];

  for (const file of files) {
    if (file.lang !== "typescript" && file.lang !== "javascript" && file.lang !== "python") {
      continue;
    }
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      for (const rule of OBFUSCATED) {
        if (!rule.pattern.test(lines[i])) continue;

        const weak = rule.title.startsWith("Very long");
        // Fixtures routinely contain the exact shape being detected, so a hit
        // inside a test is reported but never as critical.
        const severity = file.isTest ? "medium" : weak ? "medium" : "critical";

        findings.push({
          ruleId: "supply-chain/obfuscated-payload",
          category: "security",
          severity,
          confidence: weak || file.isTest ? "medium" : "high",
          source: "deps",
          title: rule.title,
          description: `${rule.title} at ${file.path}:${i + 1}. Encoded-then-executed content hides its behaviour from review and from scanners.${
            file.isTest ? " File looks like a test — likely a fixture, verify before acting." : ""
          }`,
          suggestion: "Replace with plain, reviewable code, or document why the payload must be encoded.",
          path: file.path,
          lineStart: i + 1,
          lineEnd: i + 1,
          snippet: lines[i].trim().slice(0, 200),
          symbol: "obfuscated-payload",
        });
        break;
      }
    }
  }

  return findings;
}

// --- CI workflows ----------------------------------------------------------

/** Event payload fields an attacker controls by opening a PR or issue. */
const UNTRUSTED_INTERPOLATION =
  /\$\{\{\s*github\.event\.(?:issue|pull_request|comment|review|discussion)\.[a-z_.]*(?:title|body|label|name|ref|head_ref)/i;

function checkWorkflows(files: SourceTextFile[]): FindingInput[] {
  const findings: FindingInput[] = [];

  for (const file of files) {
    if (!/^\.github\/workflows\/.+\.ya?ml$/.test(file.path)) continue;
    const lines = file.content.split("\n");
    const hasPrTarget = /^on:|pull_request_target/m.test(file.content) &&
      /pull_request_target/.test(file.content);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (UNTRUSTED_INTERPOLATION.test(line)) {
        findings.push({
          ruleId: "supply-chain/workflow-untrusted-interpolation",
          category: "security",
          severity: "critical",
          confidence: "high",
          source: "deps",
          title: "Attacker-controlled value interpolated into a workflow",
          description: `${file.path}:${i + 1} interpolates a field an outside contributor controls directly into the workflow. A crafted title or body becomes shell input on the runner.`,
          suggestion: "Pass the value through an env: block and reference it as \"$VAR\" instead of interpolating it inline.",
          path: file.path,
          lineStart: i + 1,
          lineEnd: i + 1,
          snippet: line.trim().slice(0, 200),
          symbol: "untrusted-interpolation",
        });
      }

      if (hasPrTarget && /pull_request\.head\.(?:sha|ref)/.test(line)) {
        findings.push({
          ruleId: "supply-chain/workflow-pr-target-checkout",
          category: "security",
          severity: "critical",
          confidence: "high",
          source: "deps",
          title: "pull_request_target workflow checks out untrusted code",
          description: `${file.path}:${i + 1} runs with repository secrets under pull_request_target while checking out the pull request head. Any fork can then run code with those secrets.`,
          suggestion: "Check out the base ref, or move the job to the pull_request event which has no secret access.",
          path: file.path,
          lineStart: i + 1,
          lineEnd: i + 1,
          snippet: line.trim().slice(0, 200),
          symbol: "pr-target-checkout",
        });
      }

      const reason = dangerousReason(line);
      if (reason && /^\s*(?:-\s*)?(?:run:|\s{2,})/.test(line) && /curl|wget|base64|nc\s/i.test(line)) {
        findings.push({
          ruleId: "supply-chain/workflow-remote-execution",
          category: "security",
          severity: "high",
          confidence: "medium",
          source: "deps",
          title: `Workflow step ${reason}`,
          description: `${file.path}:${i + 1} ${reason}. CI runners usually hold credentials, so remote code here runs with them.`,
          suggestion: "Pin and verify the artefact, or install it from a package manager with a lockfile.",
          path: file.path,
          lineStart: i + 1,
          lineEnd: i + 1,
          snippet: line.trim().slice(0, 200),
          symbol: "workflow-remote-execution",
        });
      }
    }
  }

  return findings;
}

// --- agent configuration ---------------------------------------------------

async function checkAgentConfigs(projectRoot: string): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];

  for (const relative of AGENT_CONFIG_FILES) {
    let content: string;
    try {
      content = await readFile(join(projectRoot, relative), "utf-8");
    } catch {
      continue;
    }

    let leaves: JsonLeaf[];
    if (relative.endsWith(".toml")) {
      leaves = tomlStringLeaves(content);
    } else {
      try {
        leaves = stringLeaves(JSON.parse(content));
      } catch {
        continue;
      }
    }

    for (const leaf of leaves) {
      if (isDenyContext(leaf.path)) continue;

      const key = leaf.path.join(".");

      if (/permissions\.allow/.test(key) && BROAD_PERMISSION.test(leaf.value)) {
        findings.push({
          ruleId: "supply-chain/agent-broad-permission",
          category: "security",
          severity: "medium",
          confidence: "high",
          source: "deps",
          title: `Agent config grants ${leaf.value}`,
          description: `${relative} pre-approves \`${leaf.value}\` for anyone who opens this repository, removing the prompt that would otherwise gate it.`,
          suggestion: "Narrow the grant to the specific commands the project actually needs.",
          path: relative,
          lineStart: leaf.line ?? lineOf(content, leaf.value),
          snippet: leaf.value.slice(0, 200),
          symbol: key,
        });
        continue;
      }

      const reason = dangerousReason(leaf.value);
      if (!reason) continue;

      const isExecutable = /command|args|hooks?|run|script|task|server/i.test(key);
      if (!isExecutable) continue;

      findings.push({
        ruleId: "supply-chain/agent-config-execution",
        category: "security",
        severity: "critical",
        confidence: "high",
        source: "deps",
        title: `Agent config ${reason}`,
        description: `${relative} (${key}) ${reason}: ${leaf.value.slice(0, 200)}. Agent configuration runs when the repository is opened, before any review of the code.`,
        suggestion: "Remove the command, or replace it with a checked-in script that can be reviewed in a diff.",
        path: relative,
        lineStart: leaf.line ?? lineOf(content, leaf.value),
        snippet: leaf.value.slice(0, 200),
        symbol: key,
      });
    }
  }

  return findings;
}

export async function scanSupplyChain(
  projectRoot: string,
  files: SourceTextFile[],
): Promise<FindingInput[]> {
  return [
    ...checkInstallScripts(files),
    ...checkObfuscatedPayloads(files),
    ...checkWorkflows(files),
    ...(await checkAgentConfigs(projectRoot)),
  ];
}
