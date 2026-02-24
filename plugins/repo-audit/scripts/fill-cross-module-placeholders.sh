#!/usr/bin/env bash
# repo-audit: Fill cross-module data into report placeholders.
#
# Reads cross-module-*.json files and replaces placeholder comments
# in script-generated reports with formatted markdown content.
#
# Requires: jq
# Usage: bash fill-cross-module-placeholders.sh [project-root]

set -o pipefail

PROJECT_ROOT="${1:-.}"
DATA_DIR="${PROJECT_ROOT}/sdlc-audit/data"
REPORTS_DIR="${PROJECT_ROOT}/sdlc-audit/reports"

# --------------------------------------------------------------------------
# Helper: validate that a cross-module JSON has the expected top-level key.
# Returns 0 if valid, 1 if invalid or missing. Logs warnings on mismatch.
# --------------------------------------------------------------------------
validate_cross_module_json() {
  local file="$1"
  local expected_key="$2"
  local label="$3"

  if [ ! -f "$file" ]; then
    return 1
  fi

  if ! jq empty "$file" 2>/dev/null; then
    echo "WARNING: ${label} is not valid JSON — skipping: $file" >&2
    return 1
  fi

  if [ "$(jq --arg k "$expected_key" 'has($k)' "$file" 2>/dev/null)" != "true" ]; then
    echo "WARNING: ${label} missing expected key '${expected_key}' — skipping: $file" >&2
    return 1
  fi

  return 0
}

# --------------------------------------------------------------------------
# Helper: replace a placeholder in a file with content.
#
# If $content is empty, the placeholder line is removed entirely.
# Uses a temp file to handle multi-line replacement safely.
# --------------------------------------------------------------------------
replace_placeholder() {
  local file="$1"
  local placeholder="$2"
  local content="$3"

  [ -f "$file" ] || return 0

  if ! grep -q "$placeholder" "$file" 2>/dev/null; then
    return 0
  fi

  local tmpfile
  tmpfile=$(mktemp)

  if [ -z "$content" ]; then
    # Remove the placeholder line
    grep -v "$placeholder" "$file" > "$tmpfile"
  else
    # Replace placeholder with content
    while IFS= read -r line; do
      if echo "$line" | grep -q "$placeholder"; then
        echo "$content"
      else
        echo "$line"
      fi
    done < "$file" > "$tmpfile"
  fi

  mv "$tmpfile" "$file"
}

# --------------------------------------------------------------------------
# AUDIT_REPORT.md — CROSS_MODULE_PLACEHOLDER
# --------------------------------------------------------------------------
fill_audit_report() {
  local report="${REPORTS_DIR}/AUDIT_REPORT.md"
  [ -f "$report" ] || return 0

  local dry_file="${DATA_DIR}/cross-module-dry.json"
  local incon_file="${DATA_DIR}/cross-module-inconsistencies.json"
  local arch_file="${DATA_DIR}/cross-module-architecture.json"

  local content=""
  local has_data=false

  # DRY violations
  if validate_cross_module_json "$dry_file" "duplications" "cross-module-dry.json"; then
    local dry_count
    dry_count=$(jq '.duplications | length' "$dry_file" 2>/dev/null)
    dry_count="${dry_count:-0}"
    if [ "$dry_count" -gt 0 ]; then
      has_data=true
      content+="## Cross-Module Analysis"$'\n'
      content+=""$'\n'
      content+="### DRY Violations"$'\n'
      content+=""$'\n'
      content+="Duplicated code or logic found across module boundaries:"$'\n'
      content+=""$'\n'
      content+=$(jq -r '
        .duplications[] |
        "- **" + (.description // "Duplication") + "**\n" +
        "  - Locations: " + ((.locations // []) | join(", ")) + "\n" +
        "  - Suggestion: " + (.suggestion // "Consolidate into a shared module.")
      ' "$dry_file" 2>/dev/null)
      content+=$'\n'
    fi
  fi

  # Inconsistencies
  if validate_cross_module_json "$incon_file" "inconsistencies" "cross-module-inconsistencies.json"; then
    local incon_count
    incon_count=$(jq '.inconsistencies | length' "$incon_file" 2>/dev/null)
    incon_count="${incon_count:-0}"
    if [ "$incon_count" -gt 0 ]; then
      if [ "$has_data" = false ]; then
        content+="## Cross-Module Analysis"$'\n'
        content+=""$'\n'
        has_data=true
      fi
      content+=""$'\n'
      content+="### Inconsistencies"$'\n'
      content+=""$'\n'
      content+=$(jq -r '
        .inconsistencies[] |
        "- **" + (.pattern_type // "Pattern") + "**: " + (.description // "(no description)") + "\n" +
        "  - Examples: " + ((.examples // []) | join(", ")) + "\n" +
        "  - Recommendation: " + (.recommendation // "Standardize across modules.")
      ' "$incon_file" 2>/dev/null)
      content+=$'\n'
    fi
  fi

  # Architecture issues
  if validate_cross_module_json "$arch_file" "architecture_issues" "cross-module-architecture.json"; then
    local arch_count
    arch_count=$(jq '.architecture_issues | length' "$arch_file" 2>/dev/null)
    arch_count="${arch_count:-0}"
    if [ "$arch_count" -gt 0 ]; then
      if [ "$has_data" = false ]; then
        content+="## Cross-Module Analysis"$'\n'
        content+=""$'\n'
        has_data=true
      fi
      content+=""$'\n'
      content+="### Architecture Issues"$'\n'
      content+=""$'\n'
      content+=$(jq -r '
        .architecture_issues[] |
        "- **" + (.type // "Issue") + "**: " + (.description // "(no description)") + "\n" +
        "  - Affected modules: " + ((.affected_modules // []) | join(", ")) + "\n" +
        "  - Suggestion: " + (.suggestion // "Review architecture.")
      ' "$arch_file" 2>/dev/null)
      content+=$'\n'
    fi
  fi

  replace_placeholder "$report" "<!-- CROSS_MODULE_PLACEHOLDER -->" "$content"
}

# --------------------------------------------------------------------------
# TECH_DEBT.md — DRY_VIOLATIONS_PLACEHOLDER + ARCHITECTURE_ISSUES_PLACEHOLDER
# --------------------------------------------------------------------------
fill_tech_debt() {
  local report="${REPORTS_DIR}/TECH_DEBT.md"
  [ -f "$report" ] || return 0

  # DRY violations
  local dry_file="${DATA_DIR}/cross-module-dry.json"
  local dry_content=""
  if validate_cross_module_json "$dry_file" "duplications" "cross-module-dry.json"; then
    local dry_count
    dry_count=$(jq '.duplications | length' "$dry_file" 2>/dev/null)
    dry_count="${dry_count:-0}"
    if [ "$dry_count" -gt 0 ]; then
      dry_content+="### Cross-Module DRY Violations"$'\n'
      dry_content+=""$'\n'
      dry_content+=$(jq -r '
        .duplications[] |
        "- **" + (.description // "Duplication") + "** (" +
        ((.locations // []) | join(", ")) + ")\n" +
        "  > " + (.suggestion // "Consolidate into a shared module.")
      ' "$dry_file" 2>/dev/null)
      dry_content+=$'\n'
    fi
  fi
  replace_placeholder "$report" "<!-- DRY_VIOLATIONS_PLACEHOLDER -->" "$dry_content"

  # Architecture issues
  local arch_file="${DATA_DIR}/cross-module-architecture.json"
  local arch_content=""
  if validate_cross_module_json "$arch_file" "architecture_issues" "cross-module-architecture.json"; then
    local arch_count
    arch_count=$(jq '.architecture_issues | length' "$arch_file" 2>/dev/null)
    arch_count="${arch_count:-0}"
    if [ "$arch_count" -gt 0 ]; then
      arch_content+="### Cross-Module Architecture Issues"$'\n'
      arch_content+=""$'\n'
      arch_content+=$(jq -r '
        .architecture_issues[] |
        "- **" + (.type // "Issue") + "**: " + (.description // "(no description)") + "\n" +
        "  Affected modules: " + ((.affected_modules // []) | join(", ")) + "\n" +
        "  > " + (.suggestion // "Review architecture.")
      ' "$arch_file" 2>/dev/null)
      arch_content+=$'\n'
    fi
  fi
  replace_placeholder "$report" "<!-- ARCHITECTURE_ISSUES_PLACEHOLDER -->" "$arch_content"
}

# --------------------------------------------------------------------------
# DEPENDENCY_GRAPH.md — DEP_GRAPH_INTERPRETATION_PLACEHOLDER
# --------------------------------------------------------------------------
fill_dep_graph() {
  local report="${REPORTS_DIR}/DEPENDENCY_GRAPH.md"
  [ -f "$report" ] || return 0

  local arch_file="${DATA_DIR}/cross-module-architecture.json"
  local content=""

  if validate_cross_module_json "$arch_file" "dependency_interpretation" "cross-module-architecture.json (dep interpretation)"; then
    local has_interpretation=false

    # Problematic cycles
    local cycle_count
    cycle_count=$(jq '.dependency_interpretation.problematic_cycles | length' "$arch_file" 2>/dev/null)
    cycle_count="${cycle_count:-0}"
    if [ "$cycle_count" -gt 0 ]; then
      has_interpretation=true
      content+="## Dependency Interpretation"$'\n'
      content+=""$'\n'
      content+="### Problematic Cycles"$'\n'
      content+=""$'\n'
      content+=$(jq -r '
        .dependency_interpretation.problematic_cycles[] |
        "- **" + ((.cycle // []) | join(" -> ")) + "**: " + (.reason // "(no reason)")
      ' "$arch_file" 2>/dev/null)
      content+=$'\n'
    fi

    # Hub assessment
    local hub_count
    hub_count=$(jq '.dependency_interpretation.hub_assessment | length' "$arch_file" 2>/dev/null)
    hub_count="${hub_count:-0}"
    if [ "$hub_count" -gt 0 ]; then
      if [ "$has_interpretation" = false ]; then
        content+="## Dependency Interpretation"$'\n'
        content+=""$'\n'
        has_interpretation=true
      fi
      content+=""$'\n'
      content+="### Hub Assessment"$'\n'
      content+=""$'\n'
      content+=$(jq -r '
        .dependency_interpretation.hub_assessment[] |
        "- **" + (.module // "unknown") + "**: " + (.assessment // "(no assessment)")
      ' "$arch_file" 2>/dev/null)
      content+=$'\n'
    fi

    # Decoupling suggestions
    local decouple_count
    decouple_count=$(jq '.dependency_interpretation.decoupling_suggestions | length' "$arch_file" 2>/dev/null)
    decouple_count="${decouple_count:-0}"
    if [ "$decouple_count" -gt 0 ]; then
      if [ "$has_interpretation" = false ]; then
        content+="## Dependency Interpretation"$'\n'
        content+=""$'\n'
        has_interpretation=true
      fi
      content+=""$'\n'
      content+="### Decoupling Suggestions"$'\n'
      content+=""$'\n'
      content+=$(jq -r '
        .dependency_interpretation.decoupling_suggestions[] |
        "- " + .
      ' "$arch_file" 2>/dev/null)
      content+=$'\n'
    fi

    # Duplicate externals
    local dup_count
    dup_count=$(jq '.duplicate_externals | length' "$arch_file" 2>/dev/null)
    dup_count="${dup_count:-0}"
    if [ "$dup_count" -gt 0 ]; then
      if [ "$has_interpretation" = false ]; then
        content+="## Dependency Interpretation"$'\n'
        content+=""$'\n'
        has_interpretation=true
      fi
      content+=""$'\n'
      content+="### Duplicate External Dependencies"$'\n'
      content+=""$'\n'
      content+=$(jq -r '
        .duplicate_externals[] |
        "- **" + (.package // "unknown") + "**: " + (.issue // "(no details)")
      ' "$arch_file" 2>/dev/null)
      content+=$'\n'
    fi
  fi

  replace_placeholder "$report" "<!-- DEP_GRAPH_INTERPRETATION_PLACEHOLDER -->" "$content"
}

# --------------------------------------------------------------------------
# TEST_COVERAGE_MAP.md — COVERAGE_GAPS_PLACEHOLDER
# --------------------------------------------------------------------------
fill_test_coverage() {
  local report="${REPORTS_DIR}/TEST_COVERAGE_MAP.md"
  [ -f "$report" ] || return 0

  local coverage_file="${DATA_DIR}/cross-module-coverage.json"
  local content=""

  if validate_cross_module_json "$coverage_file" "test_gaps" "cross-module-coverage.json"; then
    local gap_count
    gap_count=$(jq '.test_gaps | length' "$coverage_file" 2>/dev/null)
    gap_count="${gap_count:-0}"
    if [ "$gap_count" -gt 0 ]; then
      content+="## Coverage Gap Analysis"$'\n'
      content+=""$'\n'
      content+="Prioritized test gaps based on cross-module risk analysis:"$'\n'
      content+=""$'\n'
      content+=$(jq -r '
        .test_gaps | to_entries | sort_by(.value.priority // 999) | .[].value |
        "- **" + (.module // "unknown") + "** (priority: " + ((.priority // "-") | tostring) + "): " +
        (.description // "(no description)") +
        (if .risk_note then "\n  > Risk: " + .risk_note else "" end)
      ' "$coverage_file" 2>/dev/null)
      content+=$'\n'
    fi
  fi

  replace_placeholder "$report" "<!-- COVERAGE_GAPS_PLACEHOLDER -->" "$content"
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
fill_audit_report
fill_tech_debt
fill_dep_graph
fill_test_coverage

echo "Cross-module placeholders filled."
exit 0
