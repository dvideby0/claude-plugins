#!/usr/bin/env bash
# repo-audit: Write audit metadata for incremental mode support.
#
# Usage: bash write-audit-meta.sh [project-root] [audit-type] [module1 module2 ...]
#   audit-type: "full" or "incremental"
#   modules: space-separated list of module directories analyzed
#
# Output: sdlc-audit/data/.audit-meta.json

set -o pipefail

PROJECT_ROOT="${1:-.}"
AUDIT_TYPE="${2:-full}"
shift 2 2>/dev/null
MODULES=("$@")

OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data"
OUTPUT_FILE="${OUTPUT_DIR}/.audit-meta.json"

mkdir -p "$OUTPUT_DIR"

# Get timestamp
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Try to get git SHA
GIT_SHA=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "")

# Build modules JSON array
MODULES_JSON="["
first=true
for mod in "${MODULES[@]}"; do
  $first || MODULES_JSON="${MODULES_JSON},"
  MODULES_JSON="${MODULES_JSON}\"${mod}\""
  first=false
done
MODULES_JSON="${MODULES_JSON}]"

# Write JSON
{
  echo "{"
  echo "  \"last_audit\": \"${TIMESTAMP}\","
  echo "  \"last_audit_type\": \"${AUDIT_TYPE}\","
  echo "  \"modules_analyzed\": ${MODULES_JSON},"
  echo "  \"total_modules\": ${#MODULES[@]},"
  if [ -n "$GIT_SHA" ]; then
    echo "  \"git_sha\": \"${GIT_SHA}\""
  else
    echo "  \"git_sha\": null"
  fi
  echo "}"
} > "$OUTPUT_FILE"

echo "Wrote: ${OUTPUT_FILE}"
