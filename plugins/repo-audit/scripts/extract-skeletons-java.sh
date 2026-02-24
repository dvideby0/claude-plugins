#!/usr/bin/env bash
# repo-audit: Extract Java code skeletons.
# Uses grep (rg if available, fallback to grep -rn) to deterministically
# extract package declarations, imports, class/interface/enum declarations,
# and method signatures.
#
# Usage: bash extract-skeletons-java.sh [project-root]
# Output: sdlc-audit/data/skeletons/java.json
#
# This script ALWAYS exits 0. Skeleton extraction is an optimization;
# failures are logged but never cascade.

set -o pipefail

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data/skeletons"
OUTPUT_FILE="${OUTPUT_DIR}/java.json"

mkdir -p "$OUTPUT_DIR"

# Directories to exclude
EXCLUDE_DIRS="\.git|sdlc-audit|node_modules|dist|build|target|vendor|\.gradle|\.idea|out"

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
      --type java \
      --glob '!.git' --glob '!sdlc-audit' --glob '!node_modules' \
      --glob '!dist' --glob '!build' --glob '!target' --glob '!vendor' \
      --glob '!.gradle' --glob '!.idea' --glob '!out' \
      "$pattern" "$PROJECT_ROOT" 2>/dev/null || true
  else
    grep -rnE \
      --include='*.java' \
      "$pattern" "$PROJECT_ROOT" 2>/dev/null \
      | grep -vE "(${EXCLUDE_DIRS})/" || true
  fi
}

# --------------------------------------------------------------------------
# Extract data
# --------------------------------------------------------------------------

TMPDIR_WORK=$(mktemp -d "${TMPDIR:-/tmp}/repo-audit-java-skel.XXXXXX")
trap 'rm -rf "$TMPDIR_WORK"' EXIT

PACKAGES_FILE="${TMPDIR_WORK}/packages.txt"
IMPORTS_FILE="${TMPDIR_WORK}/imports.txt"
CLASSES_FILE="${TMPDIR_WORK}/classes.txt"
METHODS_FILE="${TMPDIR_WORK}/methods.txt"

do_grep '^\s*package\s+' > "$PACKAGES_FILE"
do_grep '^\s*import\s+' > "$IMPORTS_FILE"
do_grep '(public|protected|private)?\s*(abstract\s+)?(static\s+)?(final\s+)?(class|interface|enum)\s+\w+' > "$CLASSES_FILE"
do_grep '(public|protected|private)\s+(static\s+)?(final\s+)?[\w<>\[\], ]+\s+\w+\s*\(' > "$METHODS_FILE"

# --------------------------------------------------------------------------
# Collect all unique files
# --------------------------------------------------------------------------
ALL_FILES="${TMPDIR_WORK}/all_files.txt"
for f in "$PACKAGES_FILE" "$IMPORTS_FILE" "$CLASSES_FILE" "$METHODS_FILE"; do
  if [ -s "$f" ]; then
    sed -E 's/^(.+):[0-9]+:.*/\1/' "$f"
  fi
done | sort -u > "$ALL_FILES"

if [ ! -s "$ALL_FILES" ]; then
  echo "No Java files with extractable structure found."
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
    | sed -E 's/;\s*$//' \
    | tr -d '[:space:]' || echo "")

  # Imports
  local imports_json
  imports_json=$(grep "^${filepath}:" "$IMPORTS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^\s*import\s+(static\s+)?//' \
    | sed -E 's/;\s*$//' \
    | tr -d '[:space:]' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Classes / interfaces / enums
  local classes_json
  classes_json=$(grep "^${filepath}:" "$CLASSES_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/.*(class|interface|enum)\s+(\w+).*/\2 (\1)/' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Methods — extract method name with return type
  local methods_json
  methods_json=$(grep "^${filepath}:" "$METHODS_FILE" 2>/dev/null \
    | sed -E 's/^[^:]+:[0-9]+:\s*//' \
    | sed -E 's/^\s*(public|protected|private)\s+(static\s+)?(final\s+)?([\w<>\[\], ]+)\s+(\w+)\s*\(.*/\5/' \
    | grep -v '^\s*$' \
    | grep -vE '^\s*(class|interface|enum|if|for|while|switch|return|new)\s*$' \
    | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

  # Line count
  local line_count
  line_count=$(wc -l < "$filepath" 2>/dev/null | tr -d ' ' || echo "0")

  jq -n \
    --arg path "$relpath" \
    --arg pkg "$pkg" \
    --argjson imports "$imports_json" \
    --argjson classes "$classes_json" \
    --argjson methods "$methods_json" \
    --argjson line_count "$line_count" \
    '{($path): {package: $pkg, imports: $imports, classes: $classes, methods: $methods, line_count: $line_count}}'
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

echo "Java: extracted skeletons from ${FILE_COUNT} files (${ERROR_COUNT} errors)"
echo "Wrote: ${OUTPUT_FILE}"

exit 0
