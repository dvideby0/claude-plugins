/**
 * Validate module JSON files against expected schema.
 *
 * Migrated from scripts/validate-module-json.sh.
 *
 * Checks all sdlc-audit/modules/*.json files for:
 *   - Valid JSON (parseable)
 *   - Required top-level fields (directory, files, test_coverage, documentation_quality)
 *   - Valid enum values for severity, confidence, source, test_coverage, documentation_quality
 *   - File entries have path (string) and issues (array)
 *   - module_level_issues severity enum validation
 */

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { ValidationResults } from "../lib/types.js";

const VALID_SEVERITIES = new Set(["critical", "warning", "info"]);
const VALID_CONFIDENCES = new Set(["definite", "high", "medium", "low"]);
const VALID_SOURCES = new Set([
  "linter",
  "typecheck",
  "prescan",
  "llm-analysis",
  "cross-module",
]);
const VALID_TEST_COVERAGE = new Set([
  "full",
  "partial",
  "none",
  "not-applicable",
]);
const VALID_DOC_QUALITY = new Set([
  "comprehensive",
  "adequate",
  "sparse",
  "missing",
]);

const REQUIRED_FIELDS = [
  "directory",
  "files",
  "test_coverage",
  "documentation_quality",
];

/**
 * Validate a single parsed module JSON object.
 * Returns an array of error messages (empty if valid).
 */
function validateModule(data: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Check required top-level fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in data)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check field types
  const files = data.files;
  if ("files" in data && !Array.isArray(files)) {
    errors.push(
      `Field 'files' must be an array, got ${files === null ? "null" : typeof files}`,
    );
  }

  if ("directory" in data && typeof data.directory !== "string") {
    errors.push(
      `Field 'directory' must be a string, got ${typeof data.directory}`,
    );
  }

  // Enum: test_coverage
  const tc = data.test_coverage;
  if (typeof tc === "string" && !VALID_TEST_COVERAGE.has(tc)) {
    errors.push(
      `Invalid test_coverage value '${tc}' — expected: full|partial|none|not-applicable`,
    );
  }

  // Enum: documentation_quality
  const dq = data.documentation_quality;
  if (typeof dq === "string" && !VALID_DOC_QUALITY.has(dq)) {
    errors.push(
      `Invalid documentation_quality value '${dq}' — expected: comprehensive|adequate|sparse|missing`,
    );
  }

  // Validate file entries
  if (Array.isArray(files)) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as Record<string, unknown>;

      if (!("path" in file)) {
        errors.push(`files[${i}] missing required field: path`);
      }

      if (!("issues" in file)) {
        errors.push(`files[${i}] missing required field: issues`);
        continue;
      }

      const issues = file.issues;
      if (!Array.isArray(issues)) {
        errors.push(
          `files[${i}].issues must be an array, got ${issues === null ? "null" : typeof issues}`,
        );
        continue;
      }

      // Validate each issue
      for (let j = 0; j < issues.length; j++) {
        const issue = issues[j] as Record<string, unknown>;

        if (typeof issue.severity === "string" && !VALID_SEVERITIES.has(issue.severity)) {
          errors.push(
            `Invalid severity '${issue.severity}' in files[${i}].issues[${j}] — expected: critical|warning|info`,
          );
        }

        if (typeof issue.confidence === "string" && !VALID_CONFIDENCES.has(issue.confidence)) {
          errors.push(
            `Invalid confidence '${issue.confidence}' in files[${i}].issues[${j}] — expected: definite|high|medium|low`,
          );
        }

        if (typeof issue.source === "string" && !VALID_SOURCES.has(issue.source)) {
          errors.push(
            `Invalid source '${issue.source}' in files[${i}].issues[${j}] — expected: linter|typecheck|prescan|llm-analysis|cross-module`,
          );
        }
      }
    }
  }

  // Validate module_level_issues if present
  if ("module_level_issues" in data && Array.isArray(data.module_level_issues)) {
    const mli = data.module_level_issues as Array<Record<string, unknown>>;
    for (let k = 0; k < mli.length; k++) {
      const sev = mli[k].severity;
      if (typeof sev === "string" && !VALID_SEVERITIES.has(sev)) {
        errors.push(
          `Invalid severity '${sev}' in module_level_issues[${k}] — expected: critical|warning|info`,
        );
      }
    }
  }

  return errors;
}

/**
 * Validate all module JSON files in the modules directory.
 *
 * @param projectRoot Path to the project root
 * @returns Validation results, also written to disk
 */
export async function validateModuleJson(
  projectRoot: string,
): Promise<ValidationResults> {
  const modulesDir = join(projectRoot, "sdlc-audit", "modules");
  const outputDir = join(projectRoot, "sdlc-audit", "data");
  const outputFile = join(outputDir, "validation-results.json");

  await mkdir(outputDir, { recursive: true });

  let entries: string[];
  try {
    entries = await readdir(modulesDir);
  } catch {
    entries = [];
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();

  if (jsonFiles.length === 0) {
    const empty: ValidationResults = {
      validated: 0,
      passed: 0,
      failed: 0,
      errors: [],
    };
    await writeFile(outputFile, JSON.stringify(empty, null, 2));
    return empty;
  }

  let validated = 0;
  let passed = 0;
  let failed = 0;
  const allErrors: Array<{ file: string; errors: string[] }> = [];

  for (const fileName of jsonFiles) {
    validated++;
    const filePath = join(modulesDir, fileName);

    // Check: valid JSON
    let data: Record<string, unknown>;
    try {
      const raw = await readFile(filePath, "utf-8");
      data = JSON.parse(raw);
    } catch {
      failed++;
      allErrors.push({
        file: fileName,
        errors: ["Invalid JSON — not parseable"],
      });
      continue;
    }

    const fileErrors = validateModule(data);

    if (fileErrors.length > 0) {
      failed++;
      allErrors.push({ file: fileName, errors: fileErrors });
    } else {
      passed++;
    }
  }

  const result: ValidationResults = {
    validated,
    passed,
    failed,
    errors: allErrors,
  };

  await writeFile(outputFile, JSON.stringify(result, null, 2));

  return result;
}
