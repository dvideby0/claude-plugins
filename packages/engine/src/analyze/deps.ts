/**
 * Dependency inventory + vulnerability lookup.
 *
 * Lockfiles are parsed in-process; vulnerabilities come from the OSV API, so
 * no per-ecosystem audit CLI is required. Offline runs degrade to skipped.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FindingInput, Severity } from "../findings/types.js";
import type { AnalyzerOutcome } from "./tools.js";

interface Dependency {
  name: string;
  version: string;
  ecosystem: "npm" | "PyPI";
  /** The manifest or lockfile this dependency was read from. */
  source: string;
}

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns";
const MAX_DETAIL_LOOKUPS = 20;

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function parseNpmLock(raw: string): Dependency[] {
  let parsed: { packages?: Record<string, { version?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const deps: Dependency[] = [];
  for (const [key, value] of Object.entries(parsed.packages ?? {})) {
    if (!key.startsWith("node_modules/") || !value.version) continue;
    deps.push({
      name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
      version: value.version,
      ecosystem: "npm",
      source: "package.json",
    });
  }
  return deps;
}

function parseRequirements(raw: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9._-]+)/.exec(line);
    if (match) {
      deps.push({ name: match[1], version: match[2], ecosystem: "PyPI", source: "requirements.txt" });
    }
  }
  return deps;
}

function parseTomlLock(raw: string, source: string): Dependency[] {
  const deps: Dependency[] = [];
  let name: string | null = null;
  for (const line of raw.split("\n")) {
    const nameMatch = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
    if (nameMatch) {
      name = nameMatch[1];
      continue;
    }
    const versionMatch = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (versionMatch && name) {
      deps.push({ name, version: versionMatch[1], ecosystem: "PyPI", source });
      name = null;
    }
  }
  return deps;
}

export async function collectDependencies(projectRoot: string): Promise<Dependency[]> {
  const deps: Dependency[] = [];

  const npmLock = await readIfPresent(join(projectRoot, "package-lock.json"));
  if (npmLock) deps.push(...parseNpmLock(npmLock));

  const requirements = await readIfPresent(join(projectRoot, "requirements.txt"));
  if (requirements) deps.push(...parseRequirements(requirements));

  for (const lock of ["poetry.lock", "uv.lock"]) {
    const raw = await readIfPresent(join(projectRoot, lock));
    if (raw) deps.push(...parseTomlLock(raw, lock));
  }

  const seen = new Set<string>();
  return deps.filter((dep) => {
    const key = `${dep.ecosystem}:${dep.name}@${dep.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface OsvBatchResponse {
  results?: Array<{ vulns?: Array<{ id: string }> }>;
}

interface OsvVuln {
  id: string;
  summary?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
}

function severityOf(vuln: OsvVuln | undefined): Severity {
  const label = vuln?.database_specific?.severity?.toUpperCase() ?? "";
  if (label === "CRITICAL") return "critical";
  if (label === "HIGH") return "high";
  if (label === "MODERATE" || label === "MEDIUM") return "medium";
  if (label === "LOW") return "low";
  return "high";
}

export async function auditDependencies(projectRoot: string): Promise<AnalyzerOutcome> {
  const deps = await collectDependencies(projectRoot);
  if (deps.length === 0) {
    return { tool: "deps", status: "skipped", detail: "no lockfile found", findings: [] };
  }

  // OSV rejects batches over 1000 queries, and an ordinary package-lock.json
  // holds more than that — sent whole, the audit never ran on exactly the
  // repositories with the most dependencies.
  const CHUNK = 500;
  const results: NonNullable<OsvBatchResponse["results"]> = [];
  const failures: string[] = [];
  for (let start = 0; start < deps.length; start += CHUNK) {
    const slice = deps.slice(start, start + CHUNK);
    try {
      const response = await fetch(OSV_BATCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queries: slice.map((dep) => ({
            package: { name: dep.name, ecosystem: dep.ecosystem },
            version: dep.version,
          })),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        failures.push(`OSV returned ${response.status}`);
        results.push(...slice.map(() => ({})));
        continue;
      }
      const batch = (await response.json()) as OsvBatchResponse;
      const rows = batch.results ?? [];
      // Results align with deps by index; a short reply must not shift them.
      for (let i = 0; i < slice.length; i++) results.push(rows[i] ?? {});
    } catch {
      failures.push("OSV unreachable");
      results.push(...slice.map(() => ({})));
    }
  }

  if (failures.length * CHUNK >= deps.length) {
    return {
      tool: "deps",
      status: "skipped",
      detail: `${deps.length} dependencies inventoried; OSV unreachable (offline?)`,
      findings: [],
    };
  }

  const affected: Array<{ dep: Dependency; ids: string[] }> = [];
  results.forEach((result, index) => {
    const ids = (result.vulns ?? []).map((vuln) => vuln.id);
    if (ids.length > 0 && deps[index]) affected.push({ dep: deps[index], ids });
  });

  // Enrich the first few so severities aren't all guesses.
  const details = new Map<string, OsvVuln>();
  for (const { ids } of affected.slice(0, MAX_DETAIL_LOOKUPS)) {
    try {
      const response = await fetch(`${OSV_VULN_URL}/${ids[0]}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const vuln = (await response.json()) as OsvVuln;
        details.set(ids[0], vuln);
      }
    } catch {
      // Detail lookup is best-effort.
    }
  }

  const findings: FindingInput[] = affected.map(({ dep, ids }) => {
    const detail = details.get(ids[0]);
    return {
      ruleId: `deps/${dep.name}`,
      category: "dependencies",
      severity: severityOf(detail),
      confidence: "definite",
      source: "deps",
      title: `${dep.name}@${dep.version}: ${ids.length} known vulnerabilit${ids.length === 1 ? "y" : "ies"}`,
      description: [detail?.summary, `Advisories: ${ids.slice(0, 5).join(", ")}`]
        .filter(Boolean)
        .join(" — "),
      suggestion: `Upgrade ${dep.name} past ${dep.version}.`,
      path: dep.source,
      symbol: dep.name,
    };
  });

  // Partial coverage is a gap, not a pass: an "ok" here closes advisories
  // for the dependencies that were in the batches that failed.
  if (failures.length > 0) {
    const unchecked = failures.length * CHUNK;
    return {
      tool: "deps",
      status: "failed",
      detail:
        `checked ~${deps.length - unchecked} of ${deps.length} dependencies ` +
        `(${failures.join("; ")}); ${findings.length} vulnerable so far`,
      findings,
    };
  }

  return {
    tool: "deps",
    status: "ok",
    detail: `${deps.length} dependencies, ${findings.length} vulnerable`,
    findings,
  };
}
