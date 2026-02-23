#!/usr/bin/env bash
# repo-audit: Assemble AUDIT_REPORT.md from module JSONs and tool output.
#
# Extracts all issues from module analysis, sorts by severity, generates
# summary table, appends tool results and vulnerability data.
#
# Requires: jq
# Usage: bash assemble-audit-report.sh [project-root]
# Output: sdlc-audit/reports/AUDIT_REPORT.md

set -o pipefail

PROJECT_ROOT="${1:-.}"
MODULES_DIR="${PROJECT_ROOT}/sdlc-audit/modules"
DATA_DIR="${PROJECT_ROOT}/sdlc-audit/data"
TOOL_DIR="${PROJECT_ROOT}/sdlc-audit/tool-output"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/reports"
OUTPUT_FILE="${OUTPUT_DIR}/AUDIT_REPORT.md"

if ! command -v jq &>/dev/null; then
  echo "jq not available — skipping report assembly."
  exit 0
fi

shopt -s nullglob
MODULE_FILES=("${MODULES_DIR}"/*.json)
shopt -u nullglob

if [ ${#MODULE_FILES[@]} -eq 0 ]; then
  echo "No module JSONs found — skipping report assembly."
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

# --------------------------------------------------------------------------
# Extract all issues into a flat sorted list
# --------------------------------------------------------------------------
ALL_ISSUES=$(jq -s '
  [.[] | .files[]? | . as $file |
    .issues[]? | . + {file_path: $file.path, file_language: ($file.language // "unknown")}
  ] | sort_by(
    (if .severity == "critical" then 0 elif .severity == "warning" then 1 else 2 end),
    .category
  )
' "${MODULE_FILES[@]}" 2>/dev/null)

# --------------------------------------------------------------------------
# Count by severity x category for summary table
# --------------------------------------------------------------------------
SUMMARY=$(echo "$ALL_ISSUES" | jq '
  group_by(.severity) | map({
    key: .[0].severity,
    value: (group_by(.category) | map({key: .[0].category, value: length}) | from_entries)
  }) | from_entries
')

CATEGORIES=$(echo "$ALL_ISSUES" | jq -r '[.[].category // "uncategorized"] | unique | .[]' | sort)
CRIT_TOTAL=$(echo "$ALL_ISSUES" | jq '[.[] | select(.severity == "critical")] | length')
WARN_TOTAL=$(echo "$ALL_ISSUES" | jq '[.[] | select(.severity == "warning")] | length')
INFO_TOTAL=$(echo "$ALL_ISSUES" | jq '[.[] | select(.severity == "info")] | length')
GRAND_TOTAL=$(echo "$ALL_ISSUES" | jq 'length')

# --------------------------------------------------------------------------
# Write report
# --------------------------------------------------------------------------
{
  echo "# Audit Report"
  echo ""
  echo "**Total findings: ${GRAND_TOTAL}** (${CRIT_TOTAL} critical, ${WARN_TOTAL} warning, ${INFO_TOTAL} info)"
  echo ""

  # --- Summary table ---
  printf "| Severity |"
  for cat in $CATEGORIES; do printf " %s |" "$cat"; done
  printf " **Total** |\n"

  printf "|----------|"
  for cat in $CATEGORIES; do printf "------|"; done
  printf "--------|\n"

  for sev in critical warning info; do
    SEV_DISPLAY="$(echo "$sev" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
    printf "| **%s** |" "$SEV_DISPLAY"
    for cat in $CATEGORIES; do
      count=$(echo "$SUMMARY" | jq -r ".\"${sev}\".\"${cat}\" // 0" 2>/dev/null)
      count="${count:-0}"
      if [ "$count" = "0" ] || [ "$count" = "null" ]; then
        printf " - |"
      else
        printf " %s |" "$count"
      fi
    done
    case "$sev" in
      critical) printf " **%s** |\n" "$CRIT_TOTAL" ;;
      warning)  printf " **%s** |\n" "$WARN_TOTAL" ;;
      info)     printf " **%s** |\n" "$INFO_TOTAL" ;;
    esac
  done
  echo ""

  # --- Tool results summary ---
  echo "## Tools That Ran"
  echo ""
  echo "| Tool | Status | Findings |"
  echo "|------|--------|----------|"

  TOOL_JSON="${DATA_DIR}/tool-availability.json"
  if [ -f "$TOOL_JSON" ]; then
    # Linter results
    for linter_file in "${TOOL_DIR}/linter-results"/*.json; do
      [ -f "$linter_file" ] || continue
      name=$(basename "$linter_file" .json)
      count=$(jq 'if type == "array" then length else 0 end' "$linter_file" 2>/dev/null || echo "?")
      echo "| ${name} | Ran | ${count} issues |"
    done

    # Typecheck results
    for tc_file in "${TOOL_DIR}/typecheck"/*.txt; do
      [ -f "$tc_file" ] || continue
      name=$(basename "$tc_file" .txt)
      count=$(grep -c "error" "$tc_file" 2>/dev/null)
      count="${count:-0}"
      echo "| ${name} | Ran | ${count} errors |"
    done

    # Dep audit results
    for dep_file in "${TOOL_DIR}/deps"/*; do
      [ -f "$dep_file" ] || continue
      name=$(basename "$dep_file" | sed 's/\.[^.]*$//')
      echo "| ${name} | Ran | see raw output |"
    done

    # Metrics
    if [ -f "${DATA_DIR}/metrics.json" ]; then
      total_code=$(jq -r '.SUM.code // .Total.code // "?"' "${DATA_DIR}/metrics.json" 2>/dev/null)
      total_code="${total_code:-?}"
      echo "| cloc/tokei | Ran | ${total_code} lines of code |"
    fi

    # Git
    if [ -f "${DATA_DIR}/git-hotspots.txt" ]; then
      echo "| git history | Ran | see hotspots data |"
    fi
  fi
  echo ""

  # --- Systemic patterns (from variant analysis) ---
  VARIANT_FILE="${DATA_DIR}/variant-analysis.json"
  if [ -f "$VARIANT_FILE" ]; then
    systemic_count=$(jq '.systemic_patterns | length' "$VARIANT_FILE" 2>/dev/null || echo "0")
    if [ "$systemic_count" -gt 0 ]; then
      echo "## Systemic Patterns"
      echo ""
      echo "These patterns appear across 3+ modules. Fixing them systematically"
      echo "has higher ROI than addressing individual instances."
      echo ""
      jq -r '.systemic_patterns[] | "### \(.pattern // .guide_rule) (\(.severity)) — \(.occurrences // .count) occurrences\n\n**Affected files:**\n\(.files | map("- " + .) | join("\n"))\n\n**Recommendation:** \(.recommendation // "Address this pattern codebase-wide.")\n"' "$VARIANT_FILE" 2>/dev/null
      echo ""
    fi
  fi

  # --- Dependency vulnerabilities ---
  for dep_file in "${TOOL_DIR}/deps"/*.json; do
    [ -f "$dep_file" ] || continue
    name=$(basename "$dep_file" .json)
    echo "## Dependency Vulnerabilities (${name})"
    echo ""
    # Try to extract vulnerabilities — format varies by tool
    jq -r '
      if type == "object" and .vulnerabilities then
        .vulnerabilities | to_entries[:10][] |
        "- **\(.value.severity // "unknown")**: \(.key) — \(.value.title // .value.overview // "see details")"
      elif type == "object" and .advisories then
        .advisories[:10][] |
        "- **\(.severity // "unknown")**: \(.module_name // .name) — \(.title // "see details")"
      elif type == "array" then
        .[:10][] |
        "- **\(.severity // "unknown")**: \(.name // .package // "unknown") — \(.title // .overview // "see details")"
      else
        "See raw output: sdlc-audit/tool-output/deps/'"$name"'.json"
      end
    ' "$dep_file" 2>/dev/null || echo "See raw output: \`sdlc-audit/tool-output/deps/${name}.json\`"
    echo ""
  done

  # --- Type check errors ---
  for tc_file in "${TOOL_DIR}/typecheck"/*.txt; do
    [ -f "$tc_file" ] || continue
    name=$(basename "$tc_file" .txt)
    error_count=$(grep -c "error" "$tc_file" 2>/dev/null)
    error_count="${error_count:-0}"
    if [ "$error_count" -gt 0 ]; then
      echo "## Type Check Errors (${name})"
      echo ""
      echo "${error_count} errors found. Top errors:"
      echo ""
      echo '```'
      head -20 "$tc_file"
      echo '```'
      echo ""
      echo "Full output: \`sdlc-audit/tool-output/typecheck/${name}.txt\`"
      echo ""
    fi
  done

  # --- Findings by severity ---
  for sev in critical warning info; do
    SEV_DISPLAY="$(echo "$sev" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
    count=$(echo "$ALL_ISSUES" | jq "[.[] | select(.severity == \"${sev}\")] | length")
    [ "$count" = "0" ] && continue

    echo "## ${SEV_DISPLAY} Findings (${count})"
    echo ""

    echo "$ALL_ISSUES" | jq -r "
      [.[] | select(.severity == \"${sev}\")] |
      group_by(.category)[] |
      \"### \" + (.[0].category // \"uncategorized\") + \" (\" + (length | tostring) + \")\\n\\n\" +
      (map(
        \"- **\" + (.file_path // \"unknown\") + \"** \" +
        (if .line_range then \"(lines \" + (.line_range | map(tostring) | join(\"-\")) + \")\" else \"\" end) +
        \": \" + (.description // \"(no description)\") +
        (if .suggestion then \"\\n  > \" + .suggestion else \"\" end)
      ) | join(\"\\n\\n\"))
    " 2>/dev/null
    echo ""
  done

  # --- Footer ---
  echo "---"
  echo ""
  printf "*Generated by repo-audit | Tools used: "
  if [ -f "$TOOL_JSON" ]; then
    jq -r '[.tools | to_entries[] | select(.value.available == true) | .key] | join(", ")' "$TOOL_JSON" 2>/dev/null
  fi
  echo "*"

} > "$OUTPUT_FILE"

echo "Wrote: ${OUTPUT_FILE}"
