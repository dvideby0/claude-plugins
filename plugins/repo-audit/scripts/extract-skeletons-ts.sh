#!/usr/bin/env bash
# repo-audit: Extract TypeScript/JavaScript code skeletons.
# Uses grep (rg if available, fallback to grep -rn) to deterministically
# extract exports, imports, function signatures, and class declarations.
#
# Usage: bash extract-skeletons-ts.sh [project-root]
# Output: sdlc-audit/data/skeletons/typescript.json
#
# This script ALWAYS exits 0. Skeleton extraction is an optimization;
# failures are logged but never cascade.

set -o pipefail

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data/skeletons"
OUTPUT_FILE="${OUTPUT_DIR}/typescript.json"

mkdir -p "$OUTPUT_DIR"

# Directories to exclude
EXCLUDE_DIRS="node_modules|dist|build|\.next|sdlc-audit|\.git|coverage|__pycache__|\.venv|venv|target|vendor|obj"

# --------------------------------------------------------------------------
# Choose grep engine: prefer rg, fall back to grep -rn
# --------------------------------------------------------------------------
if command -v rg &>/dev/null; then
  USE_RG=true
else
  USE_RG=false
fi

# Run a grep search, returning "file:line:match" lines.
do_grep() {
  local pattern="$1"

  if $USE_RG; then
    rg -n --no-heading \
      --type-add 'tsjs:*.{ts,tsx,js,jsx}' \
      --type tsjs \
      --glob '!node_modules' --glob '!dist' --glob '!build' \
      --glob '!.next' --glob '!sdlc-audit' --glob '!coverage' \
      --glob '!.git' --glob '!vendor' --glob '!target' --glob '!obj' \
      "$pattern" "$PROJECT_ROOT" 2>/dev/null || true
  else
    grep -rnE \
      --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
      "$pattern" "$PROJECT_ROOT" 2>/dev/null \
      | grep -vE "(${EXCLUDE_DIRS})/" || true
  fi
}

# --------------------------------------------------------------------------
# Extract data
# --------------------------------------------------------------------------

TMPDIR_WORK=$(mktemp -d "${TMPDIR:-/tmp}/repo-audit-ts-skel.XXXXXX")
trap 'rm -rf "$TMPDIR_WORK"' EXIT

EXPORTS_FILE="${TMPDIR_WORK}/exports.txt"
IMPORTS_FILE="${TMPDIR_WORK}/imports.txt"
FUNCTIONS_FILE="${TMPDIR_WORK}/functions.txt"
CLASSES_FILE="${TMPDIR_WORK}/classes.txt"

do_grep '^export\s+(default\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum)\s+\w+' > "$EXPORTS_FILE"
do_grep '^import\s+' > "$IMPORTS_FILE"
do_grep '(export\s+)?(async\s+)?function\s+\w+' > "$FUNCTIONS_FILE"
do_grep '(export\s+)?class\s+\w+' > "$CLASSES_FILE"

# --------------------------------------------------------------------------
# Build JSON with jq
# --------------------------------------------------------------------------

# Collect all unique files from all result sets
ALL_FILES="${TMPDIR_WORK}/all_files.txt"
for f in "$EXPORTS_FILE" "$IMPORTS_FILE" "$FUNCTIONS_FILE" "$CLASSES_FILE"; do
  if [ -s "$f" ]; then
    sed -E 's/^(.+):[0-9]+:.*/\1/' "$f"
  fi
done | sort -u > "$ALL_FILES"

# If no files found, output empty JSON
if [ ! -s "$ALL_FILES" ]; then
  echo "No TypeScript/JavaScript files with extractable structure found."
  echo '{}' > "$OUTPUT_FILE"
  exit 0
fi

# Build a JSON object for each file
build_file_json() {
  local filepath="$1"
  local relpath

  # Make path relative to project root (pure bash — no python3/sed dependency)
  relpath="${filepath#"${PROJECT_ROOT}/"}"

  # Extract exports for this file
  local exports_json
  exports_json=$(grep "^${filepath}:" "$EXPORTS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^export\s+(default\s+)?(async\s+)?//' \
    | sed -E 's/^(function|const|let|var|class|interface|type|enum)\s+(\w+).*/\2 (\1)/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Extract import sources for this file
  local imports_json
  imports_json=$(grep "^${filepath}:" "$IMPORTS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E "s/.*from\s+['\"]([^'\"]+)['\"].*/\1/" \
    | grep -v '^import ' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Extract function names for this file
  local functions_json
  functions_json=$(grep "^${filepath}:" "$FUNCTIONS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/.*(async\s+)?function\s+(\w+).*/\2/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Get line count
  local line_count
  line_count=$(wc -l < "$filepath" 2>/dev/null | tr -d ' ' || echo "0")

  # Build the per-file JSON object
  jq -n \
    --arg path "$relpath" \
    --argjson exports "$exports_json" \
    --argjson imports "$imports_json" \
    --argjson functions "$functions_json" \
    --argjson line_count "$line_count" \
    '{($path): {exports: $exports, imports: $imports, functions: $functions, line_count: $line_count}}'
}

# Build per-file JSONs and merge them
RESULT_FILE="${TMPDIR_WORK}/result.json"
echo '{}' > "$RESULT_FILE"

FILE_COUNT=0
ERROR_COUNT=0

while IFS= read -r filepath; do
  file_json=$(build_file_json "$filepath" 2>/dev/null)
  if [ -n "$file_json" ] && echo "$file_json" | jq empty 2>/dev/null; then
    MERGED=$(jq -s '.[0] * .[1]' "$RESULT_FILE" <(echo "$file_json") 2>/dev/null)
    if [ -n "$MERGED" ]; then
      echo "$MERGED" > "$RESULT_FILE"
      FILE_COUNT=$((FILE_COUNT + 1))
    else
      ERROR_COUNT=$((ERROR_COUNT + 1))
    fi
  else
    ERROR_COUNT=$((ERROR_COUNT + 1))
  fi
done < "$ALL_FILES"

# Write final output
cp "$RESULT_FILE" "$OUTPUT_FILE"

echo "TypeScript/JS: extracted skeletons from ${FILE_COUNT} files (${ERROR_COUNT} errors)"
echo "Wrote: ${OUTPUT_FILE}"

exit 0
