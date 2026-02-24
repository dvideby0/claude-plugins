#!/usr/bin/env bash
# repo-audit: Write audit metadata for incremental mode support.
#
# Usage: bash write-audit-meta.sh [project-root] [audit-type] [plugin-root] [module1 module2 ...]
#   audit-type: "full" or "incremental"
#   plugin-root: path to the plugin directory (for version tracking)
#   modules: space-separated list of module directories analyzed
#
# Output: sdlc-audit/data/.audit-meta.json

set -o pipefail

PROJECT_ROOT="${1:-.}"
AUDIT_TYPE="${2:-full}"
PLUGIN_ROOT="${3:-}"
# Shift past the first 3 positional args to get modules list
if [ $# -ge 3 ]; then
  shift 3
else
  shift $#
fi
MODULES=("$@")

OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data"
OUTPUT_FILE="${OUTPUT_DIR}/.audit-meta.json"

mkdir -p "$OUTPUT_DIR"

# Get timestamp
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Try to get git SHA
GIT_SHA=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "")

# Read plugin version
PLUGIN_VERSION=""
if [ -n "$PLUGIN_ROOT" ] && [ -f "${PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
  PLUGIN_VERSION=$(jq -r '.version // empty' "${PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "")
fi

# Compute detection hash (hash of directory classification from detection.json)
DETECTION_HASH=""
if [ -f "${OUTPUT_DIR}/detection.json" ]; then
  DETECTION_HASH=$(jq -S '.all_directories | to_entries | map({key: .key, category: .value.category, languages: .value.languages}) | sort_by(.key)' "${OUTPUT_DIR}/detection.json" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
fi

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
    echo "  \"git_sha\": \"${GIT_SHA}\","
  else
    echo "  \"git_sha\": null,"
  fi
  if [ -n "$PLUGIN_VERSION" ]; then
    echo "  \"plugin_version\": \"${PLUGIN_VERSION}\","
  else
    echo "  \"plugin_version\": null,"
  fi
  if [ -n "$DETECTION_HASH" ]; then
    echo "  \"detection_hash\": \"${DETECTION_HASH}\""
  else
    echo "  \"detection_hash\": null"
  fi
  echo "}"
} > "$OUTPUT_FILE"

echo "Wrote: ${OUTPUT_FILE}"

exit 0
