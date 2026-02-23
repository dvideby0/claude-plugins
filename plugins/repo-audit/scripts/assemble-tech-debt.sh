#!/usr/bin/env bash
# repo-audit: Assemble TECH_DEBT.md from module JSONs and tool output.
#
# Categorizes issues by effort/impact into Quick Wins, Strategic Improvements,
# Cleanup Tasks, and Major Refactors. Includes linter violations and dep bumps.
#
# Requires: jq
# Usage: bash assemble-tech-debt.sh [project-root]
# Output: sdlc-audit/reports/TECH_DEBT.md

set -o pipefail

PROJECT_ROOT="${1:-.}"
MODULES_DIR="${PROJECT_ROOT}/sdlc-audit/modules"
TOOL_DIR="${PROJECT_ROOT}/sdlc-audit/tool-output"
DATA_DIR="${PROJECT_ROOT}/sdlc-audit/data"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/reports"
OUTPUT_FILE="${OUTPUT_DIR}/TECH_DEBT.md"

if ! command -v jq &>/dev/null; then
  echo "jq not available — skipping tech debt assembly."
  exit 0
fi

shopt -s nullglob
MODULE_FILES=("${MODULES_DIR}"/*.json)
shopt -u nullglob

if [ ${#MODULE_FILES[@]} -eq 0 ]; then
  echo "No module JSONs found — skipping tech debt assembly."
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

# Extract all issues with module context
ALL_ISSUES=$(jq -s '
  [.[] | . as $mod | .files[]? | . as $file |
    .issues[]? | . + {
      file_path: $file.path,
      module: $mod.directory,
      file_lines: ($file.lines // 0)
    }
  ]
' "${MODULE_FILES[@]}" 2>/dev/null)

{
  echo "# Tech Debt Backlog"
  echo ""
  TOTAL=$(echo "$ALL_ISSUES" | jq 'length')
  echo "**${TOTAL} issues** identified, prioritized by effort and impact."
  echo ""

  # --- Quick Wins: linter violations + info-level issues ---
  echo "## Quick Wins"
  echo "*Small effort, high impact — fix these first.*"
  echo ""

  # Existing linter violations
  HAS_LINTER=false
  for linter_file in "${TOOL_DIR}/linter-results"/*.json; do
    [ -f "$linter_file" ] || continue
    HAS_LINTER=true
    name=$(basename "$linter_file" .json)
    count=$(jq 'if type == "array" then length else 0 end' "$linter_file" 2>/dev/null || echo "?")
    echo "### ${name} violations (${count} issues)"
    echo ""
    echo "Your configured \`${name}\` already flags these. Many are auto-fixable."
    echo ""
    case "$name" in
      eslint)  echo '```bash' && echo "npx eslint . --fix" && echo '```' ;;
      ruff)    echo '```bash' && echo "ruff check . --fix" && echo '```' ;;
      biome)   echo '```bash' && echo "npx biome check . --apply" && echo '```' ;;
    esac
    echo ""
  done

  # Type errors
  for tc_file in "${TOOL_DIR}/typecheck"/*.txt; do
    [ -f "$tc_file" ] || continue
    HAS_LINTER=true
    name=$(basename "$tc_file" .txt)
    count=$(grep -c "error" "$tc_file" 2>/dev/null)
    count="${count:-0}"
    if [ "$count" -gt 0 ]; then
      echo "### ${name} type errors (${count})"
      echo ""
      echo "See \`sdlc-audit/tool-output/typecheck/${name}.txt\` for full list."
      echo ""
    fi
  done

  # Dependency version bumps
  HAS_VULN=false
  for dep_file in "${TOOL_DIR}/deps"/*.json; do
    [ -f "$dep_file" ] || continue
    HAS_VULN=true
    name=$(basename "$dep_file" .json)
    echo "### ${name} — vulnerable dependencies"
    echo ""
    echo "Known vulnerabilities fixable by version bumps. See \`sdlc-audit/tool-output/deps/${name}.json\`."
    echo ""
  done

  # Small code fixes from module analysis
  echo "$ALL_ISSUES" | jq -r '
    [.[] | select(
      .severity == "info" or
      (.severity == "warning" and (.category == "documentation" or .category == "consistency"))
    )] |
    if length > 0 then
      "### Code-level quick fixes (" + (length | tostring) + ")\n\n" +
      (sort_by(.category) | .[:20] | map(
        "- **" + (.file_path // "unknown") + "**: " + (.description // "(no description)") +
        (if .suggestion then " → " + .suggestion else "" end)
      ) | join("\n"))
    else empty end
  ' 2>/dev/null
  echo ""

  # --- Strategic Improvements: warning-level maintainability/DRY issues ---
  echo "## Strategic Improvements"
  echo "*Medium effort, high impact — plan these into sprints.*"
  echo ""

  echo "$ALL_ISSUES" | jq -r '
    [.[] | select(
      .severity == "warning" and
      (.category == "maintainability" or .category == "dry" or .category == "performance")
    )] |
    if length > 0 then
      (sort_by(.file_path) | map(
        "- **" + (.file_path // "unknown") + "** (" + (.category // "uncategorized") + "): " + (.description // "(no description)") +
        (if .suggestion then "\n  > " + .suggestion else "" end)
      ) | join("\n\n"))
    else "No strategic improvements identified." end
  ' 2>/dev/null
  echo ""

  # --- Major Refactors: critical issues + architecture concerns ---
  echo "## Major Refactors"
  echo "*Large effort, high impact — plan carefully.*"
  echo ""

  echo "$ALL_ISSUES" | jq -r '
    [.[] | select(.severity == "critical")] |
    if length > 0 then
      (sort_by(.category) | map(
        "- **" + (.file_path // "unknown") + "** (" + (.category // "uncategorized") + "): " + (.description // "(no description)") +
        (if .suggestion then "\n  > " + .suggestion else "" end)
      ) | join("\n\n"))
    else "No major refactors identified." end
  ' 2>/dev/null
  echo ""

  # --- Risk-weighted priorities ---
  RISK_FILE="${DATA_DIR}/risk-scores.json"
  if [ -f "$RISK_FILE" ]; then
    echo "## Risk-Weighted Priorities"
    echo ""
    echo "Modules with the highest risk scores should be addressed first:"
    echo ""
    echo "| Module | Risk Score | Issues | Test Coverage | Lines |"
    echo "|--------|-----------|--------|---------------|-------|"
    jq -r '.scores[:10][] |
      "| " + (.module // "unknown") + " | " + ((.risk_score // 0) | tostring) +
      " | " + ((.issue_count // 0) | tostring) +
      " | " + (.test_coverage // "unknown") +
      " | " + ((.total_lines // 0) | tostring) + " |"
    ' "$RISK_FILE" 2>/dev/null
    echo ""
  fi

  # --- Footer ---
  echo "---"
  echo "*Generated by repo-audit*"

} > "$OUTPUT_FILE"

echo "Wrote: ${OUTPUT_FILE}"
