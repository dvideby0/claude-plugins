/**
 * Extract Python code skeletons using Python's AST.
 * Migrated from scripts/extract-skeletons.py.
 *
 * Keeps spawning python3 — the Python AST provides perfect function/class
 * extraction that regex cannot replicate. The Python script is inlined as
 * a template string.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runScript } from "../../lib/subprocess.js";
import type { ExtractionResult } from "./common.js";

/**
 * The Python extraction script, inlined.
 * Identical logic to the original extract-skeletons.py.
 */
const PYTHON_SCRIPT = `
import ast
import json
import glob
import os
import sys

PROJECT_ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
EXCLUDE = {
    "node_modules", ".git", "vendor", "__pycache__", "dist", "build",
    ".venv", "venv", "target", "obj", "sdlc-audit", ".next",
}

results = {}
errors = 0

for filepath in glob.glob(os.path.join(PROJECT_ROOT, "**", "*.py"), recursive=True):
    parts = filepath.split(os.sep)
    if any(ex in parts for ex in EXCLUDE):
        continue

    relpath = os.path.relpath(filepath, PROJECT_ROOT)

    try:
        source = open(filepath).read()
        tree = ast.parse(source)
        functions, classes, imports = [], [], []

        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions.append({
                    "name": node.name,
                    "args": [a.arg for a in node.args.args if a.arg != "self"],
                    "returns": ast.unparse(node.returns) if node.returns else None,
                    "line": node.lineno,
                    "end_line": getattr(node, "end_lineno", None),
                    "is_async": isinstance(node, ast.AsyncFunctionDef),
                    "decorators": [ast.unparse(d) for d in node.decorator_list],
                })
            elif isinstance(node, ast.ClassDef):
                classes.append({
                    "name": node.name,
                    "bases": [ast.unparse(b) for b in node.bases],
                    "line": node.lineno,
                    "methods": [
                        n.name for n in node.body
                        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                    ],
                })
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append({
                    "from": node.module,
                    "names": [a.name for a in node.names],
                })
            elif isinstance(node, ast.Import):
                for a in node.names:
                    imports.append({"from": a.name, "names": [a.asname or a.name]})

        results[relpath] = {
            "functions": functions,
            "classes": classes,
            "imports": imports,
            "line_count": len(source.splitlines()),
        }
    except SyntaxError:
        results[relpath] = {"error": "syntax_error"}
        errors += 1
    except Exception:
        errors += 1

# Output JSON to stdout for the TypeScript caller to capture
json.dump({"results": results, "errors": errors}, sys.stdout)
`;

export async function extractPythonSkeletons(
  projectRoot: string,
): Promise<ExtractionResult> {
  const outputDir = join(projectRoot, "sdlc-audit", "data", "skeletons");
  const outputFile = join(outputDir, "python.json");

  await mkdir(outputDir, { recursive: true });

  try {
    const result = await runScript("python3", ["-c", PYTHON_SCRIPT, projectRoot], {
      cwd: projectRoot,
      timeout: 60_000,
    });

    const parsed = JSON.parse(result.stdout);
    const results = parsed.results ?? {};
    const errors = parsed.errors ?? 0;

    if (Object.keys(results).length === 0) {
      await writeFile(outputFile, "{}");
      return { fileCount: 0, errorCount: errors };
    }

    await writeFile(outputFile, JSON.stringify(results, null, 2));
    return { fileCount: Object.keys(results).length, errorCount: errors };
  } catch {
    // python3 not available or script error — write empty output
    await writeFile(outputFile, "{}");
    return { fileCount: 0, errorCount: 0 };
  }
}
