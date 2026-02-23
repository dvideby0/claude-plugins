#!/usr/bin/env python3
"""repo-audit: Extract code skeletons from Python files using AST.

Uses Python's built-in ast module (zero dependencies) to deterministically
extract imports, exports, function signatures, and class hierarchies.

Usage: python3 extract-skeletons.py [project-root]
Output: sdlc-audit/data/skeletons/python.json
"""

import ast
import json
import glob
import os
import sys

PROJECT_ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "sdlc-audit", "data", "skeletons")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "python.json")

EXCLUDE = {
    "node_modules", ".git", "vendor", "__pycache__", "dist", "build",
    ".venv", "venv", "target", "obj", "sdlc-audit", ".next",
}

results = {}
errors = 0

for filepath in glob.glob(os.path.join(PROJECT_ROOT, "**", "*.py"), recursive=True):
    # Skip excluded directories
    parts = filepath.split(os.sep)
    if any(ex in parts for ex in EXCLUDE):
        continue

    # Make path relative to project root
    relpath = os.path.relpath(filepath, PROJECT_ROOT)

    try:
        source = open(filepath).read()
        tree = ast.parse(source)
        functions, classes, imports = [], [], []

        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions.append(
                    {
                        "name": node.name,
                        "args": [
                            a.arg for a in node.args.args if a.arg != "self"
                        ],
                        "returns": (
                            ast.unparse(node.returns) if node.returns else None
                        ),
                        "line": node.lineno,
                        "end_line": getattr(node, "end_lineno", None),
                        "is_async": isinstance(node, ast.AsyncFunctionDef),
                        "decorators": [
                            ast.unparse(d) for d in node.decorator_list
                        ],
                    }
                )
            elif isinstance(node, ast.ClassDef):
                classes.append(
                    {
                        "name": node.name,
                        "bases": [ast.unparse(b) for b in node.bases],
                        "line": node.lineno,
                        "methods": [
                            n.name
                            for n in node.body
                            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                        ],
                    }
                )
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append(
                    {
                        "from": node.module,
                        "names": [a.name for a in node.names],
                    }
                )
            elif isinstance(node, ast.Import):
                for a in node.names:
                    imports.append(
                        {"from": a.name, "names": [a.asname or a.name]}
                    )

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

if not results:
    print("No Python files found — skipping skeleton extraction.")
    sys.exit(0)

os.makedirs(OUTPUT_DIR, exist_ok=True)
json.dump(results, open(OUTPUT_FILE, "w"), indent=2)

print(f"Python: extracted skeletons from {len(results)} files ({errors} errors)")
print(f"Wrote: {OUTPUT_FILE}")
