#!/usr/bin/env bash
# repo-audit: Extract Rust code skeletons.
# Uses grep (rg if available, fallback to grep -rn) to deterministically
# extract use statements, function signatures, structs, enums, and traits.
#
# Usage: bash extract-skeletons-rust.sh [project-root]
# Output: sdlc-audit/data/skeletons/rust.json
#
# This script ALWAYS exits 0. Skeleton extraction is an optimization;
# failures are logged but never cascade.

set -o pipefail

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data/skeletons"
OUTPUT_FILE="${OUTPUT_DIR}/rust.json"

mkdir -p "$OUTPUT_DIR"

# Directories to exclude
EXCLUDE_DIRS="target|\.git|sdlc-audit|node_modules|dist|build|vendor"

# --------------------------------------------------------------------------
# Choose grep engine: prefer rg, fall back to grep -rn
# --------------------------------------------------------------------------
if command -v rg &>/dev/null; then
  USE_RG=true
else
  USE_RG=false
fi

do_grep() {
  local pattern="$1"

  if $USE_RG; then
    rg -n --no-heading \
      --type rust \
      --glob '!target' --glob '!.git' --glob '!sdlc-audit' \
      --glob '!node_modules' --glob '!dist' --glob '!build' --glob '!vendor' \
      "$pattern" "$PROJECT_ROOT" 2>/dev/null || true
  else
    grep -rnE \
      --include='*.rs' \
      "$pattern" "$PROJECT_ROOT" 2>/dev/null \
      | grep -vE "(${EXCLUDE_DIRS})/" || true
  fi
}

# --------------------------------------------------------------------------
# Extract data
# --------------------------------------------------------------------------

TMPDIR_WORK=$(mktemp -d "${TMPDIR:-/tmp}/repo-audit-rust-skel.XXXXXX")
trap 'rm -rf "$TMPDIR_WORK"' EXIT

USES_FILE="${TMPDIR_WORK}/uses.txt"
FUNCTIONS_FILE="${TMPDIR_WORK}/functions.txt"
STRUCTS_FILE="${TMPDIR_WORK}/structs.txt"
ENUMS_FILE="${TMPDIR_WORK}/enums.txt"
TRAITS_FILE="${TMPDIR_WORK}/traits.txt"

do_grep '^use\s+' > "$USES_FILE"
do_grep '^(pub\s+)?(async\s+)?fn\s+\w+' > "$FUNCTIONS_FILE"
do_grep '^(pub\s+)?struct\s+\w+' > "$STRUCTS_FILE"
do_grep '^(pub\s+)?enum\s+\w+' > "$ENUMS_FILE"
do_grep '^(pub\s+)?trait\s+\w+' > "$TRAITS_FILE"

# --------------------------------------------------------------------------
# Collect all unique files
# --------------------------------------------------------------------------
ALL_FILES="${TMPDIR_WORK}/all_files.txt"
for f in "$USES_FILE" "$FUNCTIONS_FILE" "$STRUCTS_FILE" "$ENUMS_FILE" "$TRAITS_FILE"; do
  if [ -s "$f" ]; then
    sed -E 's/^(.+):[0-9]+:.*/\1/' "$f"
  fi
done | sort -u > "$ALL_FILES"

if [ ! -s "$ALL_FILES" ]; then
  echo "No Rust files with extractable structure found."
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

  # Use statements
  local uses_json
  uses_json=$(grep "^${filepath}:" "$USES_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^use\s+//' \
    | sed -E 's/;\s*$//' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Functions
  local functions_json
  functions_json=$(grep "^${filepath}:" "$FUNCTIONS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^(pub\s+)?(async\s+)?fn\s+(\w+).*/\3/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Structs
  local structs_json
  structs_json=$(grep "^${filepath}:" "$STRUCTS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^(pub\s+)?struct\s+(\w+).*/\2/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Enums
  local enums_json
  enums_json=$(grep "^${filepath}:" "$ENUMS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^(pub\s+)?enum\s+(\w+).*/\2/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Traits
  local traits_json
  traits_json=$(grep "^${filepath}:" "$TRAITS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^(pub\s+)?trait\s+(\w+).*/\2/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Line count
  local line_count
  line_count=$(wc -l < "$filepath" 2>/dev/null | tr -d ' ' || echo "0")

  jq -n \
    --arg path "$relpath" \
    --argjson uses "$uses_json" \
    --argjson functions "$functions_json" \
    --argjson structs "$structs_json" \
    --argjson enums "$enums_json" \
    --argjson traits "$traits_json" \
    --argjson line_count "$line_count" \
    '{($path): {uses: $uses, functions: $functions, structs: $structs, enums: $enums, traits: $traits, line_count: $line_count}}'
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

echo "Rust: extracted skeletons from ${FILE_COUNT} files (${ERROR_COUNT} errors)"
echo "Wrote: ${OUTPUT_FILE}"

exit 0
