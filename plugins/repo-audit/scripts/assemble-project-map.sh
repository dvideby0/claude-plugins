#!/usr/bin/env bash
# repo-audit: Assemble PROJECT_MAP.md from detection data, metrics, and git history.
#
# Requires: jq
# Usage: bash assemble-project-map.sh [project-root]
# Output: sdlc-audit/reports/PROJECT_MAP.md

set -o pipefail

PROJECT_ROOT="${1:-.}"
DATA_DIR="${PROJECT_ROOT}/sdlc-audit/data"
MODULES_DIR="${PROJECT_ROOT}/sdlc-audit/modules"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/reports"
OUTPUT_FILE="${OUTPUT_DIR}/PROJECT_MAP.md"

DETECTION="${DATA_DIR}/detection.json"
if [ ! -f "$DETECTION" ]; then
  echo "detection.json not found — skipping project map assembly."
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

{
  echo "# Project Map"
  echo ""

  # --- Languages and frameworks ---
  echo "## Languages"
  echo ""
  jq -r '.primary_languages // [] | if length > 0 then "**Primary:** " + join(", ") else empty end' "$DETECTION"
  jq -r '.secondary_languages // [] | if length > 0 then "\n**Secondary:** " + join(", ") else empty end' "$DETECTION"
  echo ""
  echo ""

  FRAMEWORKS=$(jq -r '.frameworks // {} | to_entries[] | "- **" + .key + ":** " + (.value | join(", "))' "$DETECTION" 2>/dev/null)
  if [ -n "$FRAMEWORKS" ]; then
    echo "## Frameworks"
    echo ""
    echo "$FRAMEWORKS"
    echo ""
  fi

  # --- Code metrics ---
  METRICS="${DATA_DIR}/metrics.json"
  if [ -f "$METRICS" ]; then
    echo "## Code Metrics"
    echo ""
    echo "| Language | Files | Code | Comments | Blanks |"
    echo "|----------|-------|------|----------|--------|"
    # Handle cloc JSON format
    jq -r '
      to_entries |
      map(select(.key != "header" and .key != "SUM")) |
      sort_by(-.value.code) |
      .[] |
      "| " + .key + " | " + (.value.nFiles // 0 | tostring) +
      " | " + (.value.code // 0 | tostring) +
      " | " + (.value.comment // 0 | tostring) +
      " | " + (.value.blank // 0 | tostring) + " |"
    ' "$METRICS" 2>/dev/null
    echo ""
    jq -r '
      .SUM // .Total |
      if . then
        "**Total: " + (.code // 0 | tostring) + " lines of code across " +
        (.nFiles // 0 | tostring) + " files**"
      else empty end
    ' "$METRICS" 2>/dev/null
    echo ""
    echo "*Source: cloc/tokei (deterministic count)*"
    echo ""
  fi

  # --- Directory map ---
  echo "## Directory Structure"
  echo ""
  jq -r '
    .all_directories // {} | to_entries |
    sort_by(.key) | .[] |
    "- **" + .key + "** — " + (.value.category // "unknown") +
    " (" + (.value.languages // [] | join(", ")) + ", ~" +
    ((.value.est_files // 0) | tostring) + " files)"
  ' "$DETECTION" 2>/dev/null
  echo ""

  # --- Tooling ---
  TOOLING=$(jq -r '.tooling // {} | to_entries | map("- **" + .key + ":** " + (if .value | type == "array" then .value | join(", ") elif .value | type == "string" then .value else (.value | tostring) end)) | .[]' "$DETECTION" 2>/dev/null)
  if [ -n "$TOOLING" ]; then
    echo "## Tooling"
    echo ""
    echo "$TOOLING"
    echo ""
  fi

  # --- Dependency graph summary ---
  DEP_FILE="${DATA_DIR}/dependency-data.json"
  if [ -f "$DEP_FILE" ]; then
    echo "## Module Dependencies"
    echo ""
    jq -r '
      .module_graph | to_entries | sort_by(.key) | .[] |
      "- **" + .key + "**" +
      (if (.value.depends_on | length) > 0 then " → " + (.value.depends_on | join(", ")) else " (no internal deps)" end) +
      (if .value.fan_in > 0 then " [" + (.value.fan_in | tostring) + " dependents]" else "" end)
    ' "$DEP_FILE" 2>/dev/null
    echo ""

    CYCLES=$(jq '.circular_dependencies | length' "$DEP_FILE" 2>/dev/null)
    CYCLES="${CYCLES:-0}"
    if [ "$CYCLES" -gt 0 ]; then
      echo "**Circular dependencies detected:**"
      jq -r '.circular_dependencies[] | "- " + join(" → ")' "$DEP_FILE" 2>/dev/null
      echo ""
    fi

    HUBS=$(jq -r '.hub_modules | if length > 0 then "**Hub modules** (high fan-in): " + join(", ") else empty end' "$DEP_FILE" 2>/dev/null)
    [ -n "$HUBS" ] && echo "$HUBS" && echo ""
  fi

  # --- Git activity ---
  HOTSPOTS="${DATA_DIR}/git-hotspots.txt"
  BUSFACTOR="${DATA_DIR}/git-busfactor.txt"
  if [ -f "$HOTSPOTS" ] || [ -f "$BUSFACTOR" ]; then
    echo "## Repository Activity (Last 6 Months)"
    echo ""
    if [ -f "$HOTSPOTS" ]; then
      echo "**Hotspots** (most frequently changed files):"
      echo ""
      # Parse the JSON-ish format
      grep '"changes"' "$HOTSPOTS" 2>/dev/null | head -10 | \
        sed 's/.*"changes": \([0-9]*\).*"file": "\([^"]*\)".*/\1 \2/' | \
        awk '{printf "%d. %s — %s changes\n", NR, $2, $1}'
      echo ""
    fi
    if [ -f "$BUSFACTOR" ]; then
      echo "**Contributors per module:**"
      echo ""
      echo '```'
      grep -A3 "^---" "$BUSFACTOR" 2>/dev/null | head -30
      echo '```'
      echo ""
      grep "Total commits" "$BUSFACTOR" 2>/dev/null
      echo ""
    fi
  fi

  # --- Per-module purpose ---
  shopt -s nullglob
  MODULE_FILES=("${MODULES_DIR}"/*.json)
  shopt -u nullglob
  if [ ${#MODULE_FILES[@]} -gt 0 ]; then
    echo "## Module Purposes"
    echo ""
    jq -s '
      sort_by(.directory) | .[] |
      "- **" + (.directory // "unknown") + "**: " + (.purpose // "no description")
    ' "${MODULE_FILES[@]}" 2>/dev/null
    echo ""
  fi

  # --- Footer ---
  echo "---"
  echo "*Generated by repo-audit*"

} > "$OUTPUT_FILE"

echo "Wrote: ${OUTPUT_FILE}"

exit 0
