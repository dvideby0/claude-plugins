#!/usr/bin/env bash
# repo-audit: Validate module JSON files against expected schema.
#
# Checks all sdlc-audit/modules/*.json files for:
#   - Valid JSON (parseable by jq)
#   - Required top-level fields (directory, files, test_coverage, documentation_quality)
#   - Valid enum values for severity, confidence, source, test_coverage, documentation_quality
#   - File entries have path (string) and issues (array)
#
# Requires: jq
# Usage: bash validate-module-json.sh [project-root]
# Output: sdlc-audit/data/validation-results.json
# Exit: 0 if all pass, 1 if any fail

set -o pipefail

PROJECT_ROOT="${1:-.}"
MODULES_DIR="${PROJECT_ROOT}/sdlc-audit/modules"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data"
OUTPUT_FILE="${OUTPUT_DIR}/validation-results.json"

shopt -s nullglob
MODULE_FILES=("${MODULES_DIR}"/*.json)
shopt -u nullglob

if [ ${#MODULE_FILES[@]} -eq 0 ]; then
  echo "No module JSONs found — nothing to validate."
  mkdir -p "$OUTPUT_DIR"
  echo '{"validated":0,"passed":0,"failed":0,"errors":[]}' > "$OUTPUT_FILE"
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

VALIDATED=0
PASSED=0
FAILED=0
ERRORS_JSON="[]"

for module_file in "${MODULE_FILES[@]}"; do
  VALIDATED=$((VALIDATED + 1))
  FILE_ERRORS="[]"
  basename_file=$(basename "$module_file")

  # Check 1: Valid JSON
  if ! jq empty "$module_file" 2>/dev/null; then
    FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Invalid JSON — not parseable" '. + [$e]')
    ERRORS_JSON=$(echo "$ERRORS_JSON" | jq \
      --arg f "$basename_file" \
      --argjson e "$FILE_ERRORS" \
      '. + [{"file": $f, "errors": $e}]')
    FAILED=$((FAILED + 1))
    continue
  fi

  # Check 2: Required top-level fields
  for field in directory files test_coverage documentation_quality; do
    has_field=$(jq --arg f "$field" 'has($f)' "$module_file")
    if [ "$has_field" != "true" ]; then
      FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Missing required field: $field" '. + [$e]')
    fi
  done

  # Check 3: Field types
  files_type=$(jq '.files | type' "$module_file" 2>/dev/null)
  if [ "$files_type" != '"array"' ]; then
    FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Field 'files' must be an array, got ${files_type}" '. + [$e]')
  fi

  dir_type=$(jq '.directory | type' "$module_file" 2>/dev/null)
  if [ "$dir_type" != '"string"' ] && [ "$(jq 'has("directory")' "$module_file")" = "true" ]; then
    FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Field 'directory' must be a string, got ${dir_type}" '. + [$e]')
  fi

  # Check 4: Enum values — test_coverage
  tc=$(jq -r '.test_coverage // empty' "$module_file" 2>/dev/null)
  if [ -n "$tc" ]; then
    case "$tc" in
      full|partial|none|not-applicable) ;;
      *) FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Invalid test_coverage value '${tc}' — expected: full|partial|none|not-applicable" '. + [$e]') ;;
    esac
  fi

  # Check 5: Enum values — documentation_quality
  dq=$(jq -r '.documentation_quality // empty' "$module_file" 2>/dev/null)
  if [ -n "$dq" ]; then
    case "$dq" in
      comprehensive|adequate|sparse|missing) ;;
      *) FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Invalid documentation_quality value '${dq}' — expected: comprehensive|adequate|sparse|missing" '. + [$e]') ;;
    esac
  fi

  # Check 6: File entries — path and issues
  if [ "$files_type" = '"array"' ]; then
    file_count=$(jq '.files | length' "$module_file")
    for ((i=0; i<file_count; i++)); do
      has_path=$(jq --argjson i "$i" '.files[$i] | has("path")' "$module_file")
      if [ "$has_path" != "true" ]; then
        FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "files[$i] missing required field: path" '. + [$e]')
      fi

      has_issues=$(jq --argjson i "$i" '.files[$i] | has("issues")' "$module_file")
      if [ "$has_issues" != "true" ]; then
        FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "files[$i] missing required field: issues" '. + [$e]')
        continue
      fi

      issues_type=$(jq --argjson i "$i" '.files[$i].issues | type' "$module_file")
      if [ "$issues_type" != '"array"' ]; then
        FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "files[$i].issues must be an array, got ${issues_type}" '. + [$e]')
        continue
      fi

      # Check severity/confidence/source enums in issues
      issue_count=$(jq --argjson i "$i" '.files[$i].issues | length' "$module_file")
      for ((j=0; j<issue_count; j++)); do
        sev=$(jq -r --argjson i "$i" --argjson j "$j" '.files[$i].issues[$j].severity // empty' "$module_file")
        if [ -n "$sev" ]; then
          case "$sev" in
            critical|warning|info) ;;
            *) FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Invalid severity '${sev}' in files[$i].issues[$j] — expected: critical|warning|info" '. + [$e]') ;;
          esac
        fi

        conf=$(jq -r --argjson i "$i" --argjson j "$j" '.files[$i].issues[$j].confidence // empty' "$module_file")
        if [ -n "$conf" ]; then
          case "$conf" in
            definite|high|medium|low) ;;
            *) FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Invalid confidence '${conf}' in files[$i].issues[$j] — expected: definite|high|medium|low" '. + [$e]') ;;
          esac
        fi

        src=$(jq -r --argjson i "$i" --argjson j "$j" '.files[$i].issues[$j].source // empty' "$module_file")
        if [ -n "$src" ]; then
          case "$src" in
            linter|typecheck|prescan|llm-analysis|cross-module) ;;
            *) FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Invalid source '${src}' in files[$i].issues[$j] — expected: linter|typecheck|prescan|llm-analysis|cross-module" '. + [$e]') ;;
          esac
        fi
      done
    done
  fi

  # Check 7: module_level_issues enums (if present)
  has_mli=$(jq 'has("module_level_issues")' "$module_file")
  if [ "$has_mli" = "true" ]; then
    mli_type=$(jq '.module_level_issues | type' "$module_file")
    if [ "$mli_type" = '"array"' ]; then
      mli_count=$(jq '.module_level_issues | length' "$module_file")
      for ((k=0; k<mli_count; k++)); do
        sev=$(jq -r --argjson k "$k" '.module_level_issues[$k].severity // empty' "$module_file")
        if [ -n "$sev" ]; then
          case "$sev" in
            critical|warning|info) ;;
            *) FILE_ERRORS=$(echo "$FILE_ERRORS" | jq --arg e "Invalid severity '${sev}' in module_level_issues[$k] — expected: critical|warning|info" '. + [$e]') ;;
          esac
        fi
      done
    fi
  fi

  # Tally results
  error_count=$(echo "$FILE_ERRORS" | jq 'length')
  if [ "$error_count" -gt 0 ]; then
    FAILED=$((FAILED + 1))
    ERRORS_JSON=$(echo "$ERRORS_JSON" | jq \
      --arg f "$basename_file" \
      --argjson e "$FILE_ERRORS" \
      '. + [{"file": $f, "errors": $e}]')
  else
    PASSED=$((PASSED + 1))
  fi
done

# Write results
jq -n \
  --argjson validated "$VALIDATED" \
  --argjson passed "$PASSED" \
  --argjson failed "$FAILED" \
  --argjson errors "$ERRORS_JSON" \
  '{validated: $validated, passed: $passed, failed: $failed, errors: $errors}' \
  > "$OUTPUT_FILE"

# Print summary
echo "Validated ${VALIDATED} modules: ${PASSED} passed, ${FAILED} failed"
if [ "$FAILED" -gt 0 ]; then
  echo "$ERRORS_JSON" | jq -r '.[] | "  FAIL: " + .file + " (" + (.errors | length | tostring) + " errors)"'
fi

echo "Wrote: ${OUTPUT_FILE}"

[ "$FAILED" -eq 0 ] || exit 1
