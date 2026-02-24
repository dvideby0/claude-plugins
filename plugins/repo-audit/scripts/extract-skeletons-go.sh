#!/usr/bin/env bash
# repo-audit: Extract Go code skeletons.
# Uses grep (rg if available, fallback to grep -rn) to deterministically
# extract package declarations, imports, function/method signatures, and
# type declarations.
#
# Usage: bash extract-skeletons-go.sh [project-root]
# Output: sdlc-audit/data/skeletons/go.json
#
# This script ALWAYS exits 0. Skeleton extraction is an optimization;
# failures are logged but never cascade.

set -o pipefail

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data/skeletons"
OUTPUT_FILE="${OUTPUT_DIR}/go.json"

mkdir -p "$OUTPUT_DIR"

# Directories to exclude
EXCLUDE_DIRS="vendor|\.git|sdlc-audit|node_modules|dist|build|target"

# --------------------------------------------------------------------------
# Choose grep engine: prefer rg, fall back to grep -rn
# --------------------------------------------------------------------------
if command -v rg &>/dev/null; then
  USE_RG=true
else
  USE_RG=false
fi

# Run a grep search returning "file:line:match" lines.
do_grep() {
  local pattern="$1"

  if $USE_RG; then
    rg -n --no-heading \
      --type go \
      --glob '!vendor' --glob '!.git' --glob '!sdlc-audit' \
      --glob '!node_modules' --glob '!dist' --glob '!build' --glob '!target' \
      "$pattern" "$PROJECT_ROOT" 2>/dev/null || true
  else
    grep -rnE \
      --include='*.go' \
      "$pattern" "$PROJECT_ROOT" 2>/dev/null \
      | grep -vE "(${EXCLUDE_DIRS})/" || true
  fi
}

# --------------------------------------------------------------------------
# Extract data
# --------------------------------------------------------------------------

TMPDIR_WORK=$(mktemp -d "${TMPDIR:-/tmp}/repo-audit-go-skel.XXXXXX")
trap 'rm -rf "$TMPDIR_WORK"' EXIT

PACKAGES_FILE="${TMPDIR_WORK}/packages.txt"
IMPORTS_FILE="${TMPDIR_WORK}/imports.txt"
FUNCTIONS_FILE="${TMPDIR_WORK}/functions.txt"
TYPES_FILE="${TMPDIR_WORK}/types.txt"

do_grep '^package\s+\w+' > "$PACKAGES_FILE"
do_grep '^import\s+' > "$IMPORTS_FILE"
do_grep '^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(' > "$FUNCTIONS_FILE"
do_grep '^type\s+\w+\s+(struct|interface)' > "$TYPES_FILE"

# Also extract multi-line import blocks: find files with "import (" and
# extract the imported paths. We do a second pass for these.
IMPORT_BLOCK_FILE="${TMPDIR_WORK}/import_blocks.txt"

# Find files with import blocks
if $USE_RG; then
  rg -l --type go \
    --glob '!vendor' --glob '!.git' --glob '!sdlc-audit' \
    'import \(' "$PROJECT_ROOT" 2>/dev/null || true
else
  grep -rlE --include='*.go' 'import \(' "$PROJECT_ROOT" 2>/dev/null \
    | grep -vE "(${EXCLUDE_DIRS})/" || true
fi > "${TMPDIR_WORK}/import_block_files.txt"

# For each file with import blocks, extract the imported paths
> "$IMPORT_BLOCK_FILE"
while IFS= read -r filepath; do
  [ -z "$filepath" ] && continue
  # Extract lines between "import (" and ")" — grab the quoted import paths
  sed -n '/^import (/,/^)/p' "$filepath" 2>/dev/null \
    | grep -oE '"[^"]+"' \
    | tr -d '"' \
    | while IFS= read -r imp; do
        echo "${filepath}:0:${imp}"
      done
done < "${TMPDIR_WORK}/import_block_files.txt" >> "$IMPORT_BLOCK_FILE"

# --------------------------------------------------------------------------
# Collect all unique files
# --------------------------------------------------------------------------
ALL_FILES="${TMPDIR_WORK}/all_files.txt"
for f in "$PACKAGES_FILE" "$IMPORTS_FILE" "$FUNCTIONS_FILE" "$TYPES_FILE" "$IMPORT_BLOCK_FILE"; do
  if [ -s "$f" ]; then
    sed -E 's/^(.+):[0-9]+:.*/\1/' "$f"
  fi
done | sort -u > "$ALL_FILES"

if [ ! -s "$ALL_FILES" ]; then
  echo "No Go files with extractable structure found."
  echo '{}' > "$OUTPUT_FILE"
  exit 0
fi

# --------------------------------------------------------------------------
# Build JSON with jq
# --------------------------------------------------------------------------

build_file_json() {
  local filepath="$1"
  local relpath

  # Make path relative to project root (pure bash — no python3/sed dependency)
  relpath="${filepath#"${PROJECT_ROOT}/"}"

  # Package declaration
  local pkg
  pkg=$(grep "^${filepath}:" "$PACKAGES_FILE" 2>/dev/null \
    | head -1 \
    | sed -E 's/^[^:]+:[0-9]+:\s*package\s+//' \
    | tr -d '[:space:]' || echo "")

  # Imports: combine single-line imports and block imports
  local imports_json
  imports_json=$(
    {
      # Single-line imports: import "fmt" or import alias "pkg"
      grep "^${filepath}:" "$IMPORTS_FILE" 2>/dev/null \
        | sed -E 's/^[^:]+:[0-9]+:\s*//' \
        | grep -oE '"[^"]+"' \
        | tr -d '"'
      # Block imports
      grep "^${filepath}:" "$IMPORT_BLOCK_FILE" 2>/dev/null \
        | sed -E 's/^[^:]+:[0-9]+://'
    } | sort -u \
      | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]'
  )

  # Functions (including methods with receivers)
  local functions_json
  functions_json=$(grep "^${filepath}:" "$FUNCTIONS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^func\s+(\([^)]+\)\s+)?(\w+)\s*\(.*/\2/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Types (struct and interface)
  local types_json
  types_json=$(grep "^${filepath}:" "$TYPES_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^type\s+(\w+)\s+(struct|interface).*/\1 (\2)/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Line count
  local line_count
  line_count=$(wc -l < "$filepath" 2>/dev/null | tr -d ' ' || echo "0")

  jq -n \
    --arg path "$relpath" \
    --arg pkg "$pkg" \
    --argjson imports "$imports_json" \
    --argjson functions "$functions_json" \
    --argjson types "$types_json" \
    --argjson line_count "$line_count" \
    '{($path): {package: $pkg, imports: $imports, functions: $functions, types: $types, line_count: $line_count}}'
}

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

cp "$RESULT_FILE" "$OUTPUT_FILE"

echo "Go: extracted skeletons from ${FILE_COUNT} files (${ERROR_COUNT} errors)"
echo "Wrote: ${OUTPUT_FILE}"

exit 0
