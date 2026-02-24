import { readFile, readdir, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { getState, updateState, persistState, addError } from "../lib/state.js";
import {
  assembleAuditReport,
  assembleDepGraphReport,
  assembleProjectMap,
  assembleTechDebtReport,
  assembleTestCoverageReport,
  fillCrossModulePlaceholders,
} from "../scripts/reports/index.js";
import { writeAuditMeta } from "../scripts/write-audit-meta.js";

// ----- Interfaces -----

type AuditType = "full" | "incremental" | "quick" | "security" | "deps" | "arch" | "patterns" | "coverage";

interface AssembleOutputsInput {
  auditType: AuditType;
  synthesisNeeded?: boolean;
}

interface SynthesisPrompt {
  name: string;
  prompt: string;
  outputPath: string;
}

interface AssembleOutputsResult {
  reportsGenerated: string[];
  taskCount: number;
  tasksBySeverity: { critical: number; high: number; medium: number; low: number };
  synthesisPrompts?: SynthesisPrompt[];
}

// ----- Helpers -----

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ----- TASKS.json generation -----

interface TaskEntry {
  id: string;
  title: string;
  severity: string;
  confidence: string;
  category: string;
  source: string;
  files: string[];
  description: string;
  suggestion?: string;
  acceptance_criteria: string;
  depends_on?: string[];
  estimated_effort: string;
  agent_hint?: string;
  systemic: boolean;
  related_findings?: string[];
}

const CATEGORY_PREFIXES: Record<string, string> = {
  security: "SEC",
  error_handling: "ERR",
  performance: "PERF",
  type_design: "TYPE",
  test_quality: "TEST",
  complexity: "CMPLX",
  consistency: "CONS",
  dependency: "DEP",
  documentation: "DOC",
  architecture: "ARCH",
  maintainability: "MAINT",
};

function estimateEffort(fileCount: number, severity: string): string {
  if (fileCount <= 1 && severity === "info") return "trivial";
  if (fileCount <= 1) return "small";
  if (fileCount <= 3) return "medium";
  if (fileCount <= 10) return "large";
  return "epic";
}

function normalizeCategory(category: string): string {
  const cat = category.toLowerCase().replace(/[- ]/g, "_");
  if (CATEGORY_PREFIXES[cat]) return cat;
  // Try to map common variations
  if (cat.includes("secur")) return "security";
  if (cat.includes("error") || cat.includes("exception")) return "error_handling";
  if (cat.includes("perf") || cat.includes("speed")) return "performance";
  if (cat.includes("type")) return "type_design";
  if (cat.includes("test")) return "test_quality";
  if (cat.includes("complex")) return "complexity";
  if (cat.includes("consist")) return "consistency";
  if (cat.includes("dep")) return "dependency";
  if (cat.includes("doc")) return "documentation";
  if (cat.includes("arch")) return "architecture";
  return "maintainability";
}

function normalizeSeverity(sev: string): string {
  const s = sev?.toLowerCase() ?? "medium";
  if (s === "critical") return "critical";
  if (s === "warning" || s === "high") return "high";
  if (s === "info" || s === "low") return "low";
  return "medium";
}

/**
 * Collect findings from all data sources and produce grouped TASKS.json entries.
 */
async function generateTasks(auditDir: string, auditType: AuditType): Promise<TaskEntry[]> {
  const tasks: TaskEntry[] = [];
  const counters: Record<string, number> = {};

  function nextId(category: string): string {
    const prefix = CATEGORY_PREFIXES[category] ?? "MISC";
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}-${String(counters[prefix]).padStart(3, "0")}`;
  }

  // --- Source 1: Module JSONs ---
  const modulesDir = join(auditDir, "modules");
  try {
    const moduleFiles = await readdir(modulesDir);
    // Group issues by guide_rule (or description hash) for dedup/grouping
    const issueGroups = new Map<string, {
      files: string[];
      description: string;
      severity: string;
      confidence: string;
      category: string;
      source: string;
      suggestion?: string;
      guide_rule?: string;
    }>();

    for (const file of moduleFiles) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await readFile(join(modulesDir, file), "utf-8");
        const module = JSON.parse(data);

        // File-level issues
        for (const f of module.files ?? []) {
          for (const issue of f.issues ?? []) {
            const groupKey = issue.guide_rule || issue.description || "";
            if (!groupKey) continue;

            const existing = issueGroups.get(groupKey);
            const fileRef = issue.line_range
              ? `${f.path}:${issue.line_range}`
              : f.path;

            if (existing) {
              if (!existing.files.includes(fileRef)) {
                existing.files.push(fileRef);
              }
            } else {
              issueGroups.set(groupKey, {
                files: [fileRef],
                description: issue.description ?? groupKey,
                severity: issue.severity ?? "warning",
                confidence: issue.confidence ?? "medium",
                category: normalizeCategory(issue.category ?? "maintainability"),
                source: issue.source ?? "module-agent",
                suggestion: issue.suggestion,
                guide_rule: issue.guide_rule,
              });
            }
          }
        }

        // Module-level issues
        for (const issue of module.module_level_issues ?? []) {
          const cat = normalizeCategory(issue.category ?? "architecture");
          const id = nextId(cat);
          tasks.push({
            id,
            title: (issue.description ?? "Module-level issue").slice(0, 120),
            severity: normalizeSeverity(issue.severity ?? "warning"),
            confidence: issue.confidence ?? "medium",
            category: cat,
            source: "module-agent",
            files: [module.directory ?? file.replace(/\.json$/, "")],
            description: issue.description ?? "",
            suggestion: issue.suggestion,
            acceptance_criteria: issue.acceptance_criteria ?? `Resolve the ${cat.replace(/_/g, " ")} issue and verify no regressions.`,
            estimated_effort: estimateEffort(1, issue.severity ?? "warning"),
            systemic: false,
          });
        }
      } catch {
        // Skip unreadable modules
      }
    }

    // Convert grouped issues to tasks
    for (const [, group] of issueGroups) {
      const cat = group.category;
      const id = nextId(cat);
      const isSystemic = group.files.length >= 3;
      const title = isSystemic
        ? `${group.description.slice(0, 90)} (${group.files.length} instances)`
        : group.description.slice(0, 120);

      tasks.push({
        id,
        title,
        severity: normalizeSeverity(group.severity),
        confidence: group.confidence,
        category: cat,
        source: group.source === "linter" || group.source === "typecheck" || group.source === "prescan"
          ? group.source : "module-agent",
        files: group.files,
        description: group.description,
        suggestion: group.suggestion,
        acceptance_criteria: `Fix all ${group.files.length} instance(s) and verify with project linters/tests.`,
        estimated_effort: estimateEffort(group.files.length, group.severity),
        systemic: isSystemic,
      });
    }
  } catch {
    // No modules directory
  }

  // --- Source 2: Specialist findings ---
  const specialistDir = join(auditDir, "specialists");
  try {
    const specFiles = await readdir(specialistDir);
    for (const file of specFiles) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await readFile(join(specialistDir, file), "utf-8");
        const specialist = JSON.parse(data);
        const domain = specialist.domain ?? file.replace("-findings.json", "");

        for (const finding of specialist.findings ?? []) {
          const cat = normalizeCategory(finding.category ?? domain);
          const id = nextId(cat);
          const files = Array.isArray(finding.files)
            ? finding.files
            : finding.file ? [finding.file] : [];

          tasks.push({
            id,
            title: (finding.title ?? finding.description ?? "Specialist finding").slice(0, 120),
            severity: normalizeSeverity(finding.severity ?? "warning"),
            confidence: finding.confidence ?? "high",
            category: cat,
            source: "specialist",
            files,
            description: finding.description ?? "",
            suggestion: finding.suggestion,
            acceptance_criteria: finding.acceptance_criteria
              ?? `Address the ${cat.replace(/_/g, " ")} finding and verify.`,
            estimated_effort: estimateEffort(files.length, finding.severity ?? "warning"),
            systemic: finding.systemic ?? false,
          });
        }
      } catch {
        // Skip unreadable specialist files
      }
    }
  } catch {
    // No specialists directory
  }

  // --- Source 3: Cross-module findings ---
  const dataDir = join(auditDir, "data");
  const crossModuleFiles = [
    "cross-module-dry.json",
    "cross-module-inconsistencies.json",
    "cross-module-architecture.json",
    "cross-module-coverage.json",
  ];

  for (const cmFile of crossModuleFiles) {
    try {
      const data = await readFile(join(dataDir, cmFile), "utf-8");
      const cm = JSON.parse(data);

      // DRY violations
      for (const dup of cm.duplications ?? []) {
        const id = nextId("maintainability");
        tasks.push({
          id,
          title: `DRY: ${(dup.description ?? "Code duplication").slice(0, 110)}`,
          severity: normalizeSeverity(dup.severity ?? "warning"),
          confidence: dup.confidence ?? "medium",
          category: "maintainability",
          source: "cross-module",
          files: dup.locations ?? [],
          description: dup.description ?? "",
          suggestion: dup.suggestion,
          acceptance_criteria: "Duplicated code centralized into a shared utility/module.",
          estimated_effort: estimateEffort((dup.locations ?? []).length, "warning"),
          systemic: true,
        });
      }

      // Inconsistencies
      for (const inc of cm.inconsistencies ?? []) {
        const id = nextId("consistency");
        const files = (inc.examples ?? []).map((e: any) => e.module).filter(Boolean);
        tasks.push({
          id,
          title: `Inconsistency: ${(inc.description ?? "Pattern inconsistency").slice(0, 100)}`,
          severity: normalizeSeverity(inc.severity ?? "info"),
          confidence: inc.confidence ?? "medium",
          category: "consistency",
          source: "cross-module",
          files,
          description: inc.description ?? "",
          suggestion: inc.recommendation,
          acceptance_criteria: "Consistent pattern applied across all listed modules.",
          estimated_effort: estimateEffort(files.length, "info"),
          systemic: true,
        });
      }

      // Architecture issues
      for (const arch of cm.architecture_issues ?? []) {
        const id = nextId("architecture");
        tasks.push({
          id,
          title: `Architecture: ${(arch.description ?? "Architecture issue").slice(0, 100)}`,
          severity: normalizeSeverity(arch.severity ?? "warning"),
          confidence: arch.confidence ?? "low",
          category: "architecture",
          source: "cross-module",
          files: arch.modules ?? [],
          description: arch.description ?? "",
          suggestion: arch.suggestion,
          acceptance_criteria: "Architecture concern addressed per suggestion.",
          estimated_effort: estimateEffort((arch.modules ?? []).length, arch.severity ?? "warning"),
          systemic: true,
        });
      }

      // Test gaps
      for (const gap of cm.test_gaps ?? []) {
        const id = nextId("test_quality");
        tasks.push({
          id,
          title: `Test gap: ${gap.module ?? "Unknown"} (${gap.coverage ?? "unknown"} coverage)`,
          severity: normalizeSeverity(gap.priority ?? "medium"),
          confidence: "high",
          category: "test_quality",
          source: "cross-module",
          files: [gap.module ?? ""],
          description: `${gap.module} has ${gap.coverage} test coverage. Missing: ${(gap.missing_types ?? []).join(", ")}. ${gap.risk_note ?? ""}`,
          acceptance_criteria: `Add ${(gap.missing_types ?? ["tests"]).join(" and ")} tests for ${gap.module}.`,
          estimated_effort: estimateEffort(1, gap.priority ?? "medium"),
          systemic: false,
        });
      }

      // Doc gaps
      for (const gap of cm.doc_gaps ?? []) {
        const id = nextId("documentation");
        tasks.push({
          id,
          title: `Docs: ${gap.module ?? "Unknown"} missing ${(gap.missing ?? []).join(", ")}`,
          severity: normalizeSeverity(gap.priority ?? "low"),
          confidence: "high",
          category: "documentation",
          source: "cross-module",
          files: [gap.module ?? ""],
          description: `${gap.module} has ${gap.coverage} documentation. Missing: ${(gap.missing ?? []).join(", ")}.`,
          acceptance_criteria: `Add ${(gap.missing ?? ["documentation"]).join(" and ")} for ${gap.module}.`,
          estimated_effort: estimateEffort(1, gap.priority ?? "low"),
          systemic: false,
        });
      }
    } catch {
      // File doesn't exist or isn't valid JSON
    }
  }

  // --- Source 4: Variant analysis ---
  try {
    const data = await readFile(join(dataDir, "variant-analysis.json"), "utf-8");
    const variants = JSON.parse(data);

    for (const [rule, pattern] of Object.entries(variants.systemic_patterns ?? {}) as [string, any][]) {
      const cat = normalizeCategory(pattern.category ?? "maintainability");
      const id = nextId(cat);
      tasks.push({
        id,
        title: `Systemic: ${rule} (${pattern.count} instances across ${(pattern.directories ?? []).length} dirs)`,
        severity: normalizeSeverity(pattern.severity ?? "warning"),
        confidence: "high",
        category: cat,
        source: "variant-analysis",
        files: pattern.files ?? [],
        description: `Systemic pattern "${rule}" found ${pattern.count} times across ${(pattern.directories ?? []).length} directories.`,
        acceptance_criteria: `Address all ${pattern.count} instances of ${rule}.`,
        estimated_effort: estimateEffort(pattern.count ?? 1, pattern.severity ?? "warning"),
        systemic: true,
      });
    }
  } catch {
    // No variant analysis
  }

  // Sort by severity (critical first), then by file count (more files = higher priority)
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  tasks.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2);
    if (sevDiff !== 0) return sevDiff;
    return b.files.length - a.files.length;
  });

  return tasks;
}

// ----- Synthesis prompts -----

function buildPatternsPrompt(auditDir: string): SynthesisPrompt {
  return {
    name: "patterns",
    prompt: `You are a codebase patterns analyzer.

Read ALL JSON files in ${auditDir}/modules/ and ${auditDir}/data/cross-module-*.json.

Write ${auditDir}/reports/PATTERNS.md documenting every discovered convention
(good and problematic):

- Naming conventions (per language, per module)
- Error handling patterns
- Testing patterns
- State management
- API design
- File organization
- Auth patterns
- Logging conventions
- Config management

For each pattern, note:
- Where it appears (which modules/files)
- Whether it's consistently applied
- Whether it's a good practice or an anti-pattern
- Recommended standardization (if inconsistent)

End with a footer: ---\\n*Generated by repo-audit*`,
    outputPath: join(auditDir, "reports", "PATTERNS.md"),
  };
}

function buildClaudeMdPrompt(auditDir: string): SynthesisPrompt {
  return {
    name: "claude-md",
    prompt: `You are a CLAUDE.md convention synthesizer.

Read ALL JSON files in ${auditDir}/modules/ and ${auditDir}/data/cross-module-*.json.
Also read ${auditDir}/data/detection.json for project structure.

Write ${auditDir}/staged/CLAUDE.md with proposed conventions for this project.

IMPORTANT: Do NOT modify the project's existing CLAUDE.md. Write ONLY to
${auditDir}/staged/CLAUDE.md.

Format:

# Proposed CLAUDE.md Updates
# Generated by repo-audit on ${new Date().toISOString().split("T")[0]}
#
# Review the content below and copy what you want into your project's CLAUDE.md.
# To apply: copy desired sections into your CLAUDE.md at the project root.

## Codebase Orientation
Read sdlc-audit/reports/PROJECT_MAP.md for full codebase orientation.

## Discovered Conventions
[Naming, error handling, testing, async patterns, etc.]

## Anti-Patterns to Avoid
[Specific patterns found in this codebase that should not be repeated]

## Key Architectural Decisions
[Major design choices discovered during the audit]

## Per-Directory Conventions
### [directory]/
[Conventions specific to this directory]
[... for each major directory]

## Testing Conventions
[Testing patterns, frameworks, file organization]

## Error Handling Conventions
[Error handling approach used in this codebase]

End with a footer: ---\\n*Generated by repo-audit*`,
    outputPath: join(auditDir, "staged", "CLAUDE.md"),
  };
}

// ----- Main tool function -----

export async function assembleOutputs(
  input: AssembleOutputsInput,
  pluginRoot: string,
): Promise<AssembleOutputsResult> {
  const state = getState();
  if (!state) {
    throw new Error("State not initialized. Call audit_discover first.");
  }

  const projectRoot = state.projectRoot;
  const auditDir = state.auditDir;
  const auditType = input.auditType;
  const synthesisNeeded = input.synthesisNeeded ?? true;

  updateState({ phase: "assembling" });

  // Ensure output directories exist
  await mkdir(join(auditDir, "reports"), { recursive: true });
  await mkdir(join(auditDir, "staged"), { recursive: true });

  // Step 1: Run assembly functions in parallel
  const assemblers = [
    { name: "audit-report", fn: () => assembleAuditReport(projectRoot) },
    { name: "project-map", fn: () => assembleProjectMap(projectRoot) },
    { name: "tech-debt", fn: () => assembleTechDebtReport(projectRoot) },
    { name: "test-coverage", fn: () => assembleTestCoverageReport(projectRoot) },
    { name: "dep-graph", fn: () => assembleDepGraphReport(projectRoot) },
  ];

  const scriptResults = await Promise.allSettled(
    assemblers.map((a) => a.fn()),
  );

  for (let i = 0; i < scriptResults.length; i++) {
    const result = scriptResults[i];
    if (result.status === "rejected") {
      addError(
        "audit_assemble_outputs",
        `${assemblers[i].name} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }

  // Step 2: Fill cross-module placeholders
  try {
    await fillCrossModulePlaceholders(projectRoot);
  } catch (err) {
    addError(
      "audit_assemble_outputs",
      `fill-cross-module-placeholders failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 3: Write audit metadata
  try {
    const moduleNames = state.moduleAssignments.map((a) => a.directories[0]);
    await writeAuditMeta({
      projectRoot,
      auditType,
      pluginRoot,
      modules: moduleNames,
    });
  } catch (err) {
    addError(
      "audit_assemble_outputs",
      `write-audit-meta failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 4: Generate TASKS.json
  const tasks = await generateTasks(auditDir, auditType);

  const tasksBySeverity = {
    critical: tasks.filter((t) => t.severity === "critical").length,
    high: tasks.filter((t) => t.severity === "high").length,
    medium: tasks.filter((t) => t.severity === "medium").length,
    low: tasks.filter((t) => t.severity === "low").length,
  };

  const byCategory: Record<string, number> = {};
  for (const t of tasks) {
    byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
  }

  const totalEffortMap: Record<string, number> = {
    trivial: 5, small: 30, medium: 120, large: 480, epic: 960,
  };
  const totalMinutes = tasks.reduce(
    (sum, t) => sum + (totalEffortMap[t.estimated_effort] ?? 60), 0,
  );
  const totalHours = Math.round(totalMinutes / 60);
  const estimatedTotalEffort = totalHours < 8
    ? `~${totalHours} hours`
    : `~${Math.round(totalHours / 8)} days`;

  const tasksJson = {
    version: "1.0.0",
    generated: new Date().toISOString(),
    auditType,
    summary: {
      totalTasks: tasks.length,
      bySeverity: tasksBySeverity,
      byCategory,
      estimatedTotalEffort,
    },
    tasks,
  };

  await writeFile(
    join(auditDir, "TASKS.json"),
    JSON.stringify(tasksJson, null, 2),
  );

  // Check which reports were generated
  const reportFiles = [
    "AUDIT_REPORT.md",
    "PROJECT_MAP.md",
    "TECH_DEBT.md",
    "TEST_COVERAGE_MAP.md",
    "DEPENDENCY_GRAPH.md",
  ];

  const reportsGenerated: string[] = [];
  for (const report of reportFiles) {
    if (await fileExists(join(auditDir, "reports", report))) {
      reportsGenerated.push(report);
    }
  }
  // Always count TASKS.json
  reportsGenerated.push("TASKS.json");

  // Step 5: Synthesis prompts (if needed)
  let synthesisPrompts: SynthesisPrompt[] | undefined;
  if (synthesisNeeded) {
    synthesisPrompts = [
      buildPatternsPrompt(auditDir),
      buildClaudeMdPrompt(auditDir),
    ];
  }

  updateState({ phase: "complete" });
  await persistState();

  return {
    reportsGenerated,
    taskCount: tasks.length,
    tasksBySeverity,
    synthesisPrompts,
  };
}
