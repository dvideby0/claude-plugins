#!/usr/bin/env bash
# repo-audit: Merge sub-command findings into standard module JSONs.
#
# Takes a findings JSON file (from a sub-command like audit-security) and
# merges its issues into the standard sdlc-audit/modules/ schema. Creates
# the module JSON if it doesn't exist, or merges into existing.
#
# Requires: jq
# Usage: bash merge-module-findings.sh [project-root] [findings-file] [source-command]
#
# The findings-file should be a JSON with a "findings" array where each entry
# has at minimum: file, severity, description, and optionally: confidence,
# source, category, line_range, etc.
#
# The source-command string (e.g. "audit-security") is added to a "sources"
# array in each affected module JSON for tracking.

set -o pipefail

PROJECT_ROOT="${1:-.}"
FINDINGS_FILE="${2}"
SOURCE_COMMAND="${3}"

MODULES_DIR="${PROJECT_ROOT}/sdlc-audit/modules"
DETECTION_FILE="${PROJECT_ROOT}/sdlc-audit/data/detection.json"

# --- Validate inputs ---

if [ -z "$FINDINGS_FILE" ]; then
  echo "Error: findings file path is required." >&2
  echo "Usage: bash merge-module-findings.sh [project-root] [findings-file] [source-command]" >&2
  exit 1
fi

if [ -z "$SOURCE_COMMAND" ]; then
  echo "Error: source-command is required." >&2
  echo "Usage: bash merge-module-findings.sh [project-root] [findings-file] [source-command]" >&2
  exit 1
fi

if [ ! -f "$FINDINGS_FILE" ]; then
  echo "Error: findings file not found: $FINDINGS_FILE" >&2
  exit 1
fi

if ! jq empty "$FINDINGS_FILE" 2>/dev/null; then
  echo "Error: findings file is not valid JSON: $FINDINGS_FILE" >&2
  exit 1
fi

# Check that findings array exists
FINDINGS_COUNT=$(jq '.findings | length // 0' "$FINDINGS_FILE" 2>/dev/null)
if [ "$FINDINGS_COUNT" = "0" ] || [ "$FINDINGS_COUNT" = "null" ]; then
  echo "No findings to merge (findings array is empty or missing)."
  exit 0
fi

mkdir -p "$MODULES_DIR"

# --- Build directory mapping from detection.json ---
# Maps file path prefixes to module directory names.
# If detection.json doesn't exist, fall back to deriving module from file path.

DIR_MAP="{}"
if [ -f "$DETECTION_FILE" ] && jq empty "$DETECTION_FILE" 2>/dev/null; then
  DIR_MAP=$(jq '.all_directories // {}' "$DETECTION_FILE")
fi

# --- Group findings by module directory ---
# For each finding, determine which module it belongs to by matching
# its file path against detection.json directories (longest prefix match).
# Then merge into the appropriate module JSON.

# Extract all findings and group them by their module directory.
# The grouping logic:
#   1. For each finding's "file" field, find the best matching directory
#      from detection.json (longest prefix match)
#   2. If no match, derive module name from the first two path components
#   3. Group findings by module directory

GROUPED=$(jq -n \
  --argjson findings "$(jq '.findings' "$FINDINGS_FILE")" \
  --argjson dir_map "$DIR_MAP" \
  '
# Build sorted directory list (longest first for prefix matching)
($dir_map | keys | sort_by(- length)) as $dirs |

# For each finding, determine module directory
[
  $findings[] |
  . as $finding |
  $finding.file as $fpath |

  # Find longest matching directory prefix
  (
    [
      $dirs[] |
      . as $dir |
      # Normalize: remove trailing slash for comparison
      ($dir | rtrimstr("/")) as $norm_dir |
      select(
        $fpath == $norm_dir or
        ($fpath | startswith($norm_dir + "/"))
      ) |
      $dir
    ] | first
  ) as $matched_dir |

  # If no match from detection.json, derive from path
  (
    if $matched_dir then
      $matched_dir | rtrimstr("/")
    else
      # Use first two path components or the directory portion
      ($fpath | split("/") |
        if length > 2 then .[0:2] | join("/")
        elif length == 2 then .[0]
        else "_root_"
        end)
    end
  ) as $module_dir |

  {module_dir: $module_dir, finding: $finding}
] |

# Group by module_dir
group_by(.module_dir) |
map({
  key: .[0].module_dir,
  value: [.[].finding]
}) |
from_entries
')

if [ -z "$GROUPED" ] || [ "$GROUPED" = "null" ]; then
  echo "Error: failed to group findings by module." >&2
  exit 1
fi

# --- Process each module group ---

MODULE_DIRS=$(echo "$GROUPED" | jq -r 'keys[]')
MERGED_COUNT=0
CREATED_COUNT=0

while IFS= read -r module_dir; do
  [ -z "$module_dir" ] && continue

  # Sanitize module name for filename (replace / with _)
  module_name=$(echo "$module_dir" | sed 's|/|_|g')
  module_file="${MODULES_DIR}/${module_name}.json"

  # Get findings for this module
  MODULE_FINDINGS=$(echo "$GROUPED" | jq --arg d "$module_dir" '.[$d]')

  if [ -f "$module_file" ] && jq empty "$module_file" 2>/dev/null; then
    # --- Merge into existing module JSON ---
    EXISTING=$(jq '.' "$module_file")

    UPDATED=$(jq -n \
      --argjson existing "$EXISTING" \
      --argjson new_findings "$MODULE_FINDINGS" \
      --arg source "$SOURCE_COMMAND" \
      '
# Add source to sources array (create if absent, deduplicate)
($existing.sources // []) as $old_sources |
(if ($old_sources | index($source)) then $old_sources
 else $old_sources + [$source] end) as $new_sources |

# Build map of existing issues per file path for deduplication
# Key: file path, Value: array of {description, line_range} for dedup
(
  reduce ($existing.files // [])[] as $f
    ({};
      .[$f.path] = ($f.issues // [])
    )
) as $existing_issues_map |

# For each new finding, merge into the appropriate file entry
(
  reduce $new_findings[] as $nf
    ($existing_issues_map;
      $nf.file as $fpath |
      # Build the issue object from the finding
      (
        {
          severity: $nf.severity,
          description: $nf.description
        }
        + (if $nf.confidence then {confidence: $nf.confidence} else {} end)
        + (if $nf.category then {category: $nf.category} else {} end)
        + (if $nf.source then {source: $nf.source} else {} end)
        + (if $nf.line_range then {line_range: $nf.line_range} else {} end)
        + (if $nf.impact then {impact: $nf.impact} else {} end)
        + (if $nf.remediation then {remediation: $nf.remediation} else {} end)
        + (if $nf.owasp then {owasp: $nf.owasp} else {} end)
        + (if $nf.guide_rule then {guide_rule: $nf.guide_rule} else {} end)
      ) as $new_issue |
      # Check for duplicate: same description + file + line_range
      (
        (.[$fpath] // []) | any(
          .description == $new_issue.description and
          .line_range == $new_issue.line_range
        )
      ) as $is_dup |
      if $is_dup then .
      else .[$fpath] = ((.[$fpath] // []) + [$new_issue])
      end
    )
) as $merged_issues_map |

# Rebuild the files array, preserving existing file entries and adding new ones
(
  # Collect all file paths (existing + new)
  (
    [($existing.files // [])[] | .path] +
    [$new_findings[] | .file]
  ) | unique
) as $all_paths |

(
  # Build lookup of existing file entries
  reduce ($existing.files // [])[] as $f
    ({};
      .[$f.path] = $f
    )
) as $existing_files_map |

[
  $all_paths[] | . as $path |
  if $existing_files_map[$path] then
    # Update existing file entry with merged issues
    $existing_files_map[$path] | .issues = ($merged_issues_map[$path] // [])
  else
    # Create new file entry
    {
      path: $path,
      issues: ($merged_issues_map[$path] // [])
    }
  end
] as $new_files |

$existing + {
  files: $new_files,
  sources: $new_sources
}
')

    echo "$UPDATED" | jq '.' > "$module_file"
    MERGED_COUNT=$((MERGED_COUNT + 1))
  else
    # --- Create new skeleton module JSON ---

    # Determine category from detection.json if available
    CATEGORY=$(echo "$DIR_MAP" | jq -r --arg d "$module_dir" --arg ds "${module_dir}/" '
      if .[$d] then .[$d].category
      elif .[$ds] then .[$ds].category
      else "source"
      end
    ')
    [ "$CATEGORY" = "null" ] && CATEGORY="source"

    # Determine languages from detection.json if available
    LANGUAGES=$(echo "$DIR_MAP" | jq --arg d "$module_dir" --arg ds "${module_dir}/" '
      if .[$d] then (.[$d].languages // [])
      elif .[$ds] then (.[$ds].languages // [])
      else []
      end
    ')

    NEW_MODULE=$(jq -n \
      --arg dir "$module_dir" \
      --arg category "$CATEGORY" \
      --argjson languages "$LANGUAGES" \
      --argjson new_findings "$MODULE_FINDINGS" \
      --arg source "$SOURCE_COMMAND" \
      '
# Group findings by file path
(
  reduce $new_findings[] as $nf
    ({};
      $nf.file as $fpath |
      (
        {
          severity: $nf.severity,
          description: $nf.description
        }
        + (if $nf.confidence then {confidence: $nf.confidence} else {} end)
        + (if $nf.category then {category: $nf.category} else {} end)
        + (if $nf.source then {source: $nf.source} else {} end)
        + (if $nf.line_range then {line_range: $nf.line_range} else {} end)
        + (if $nf.impact then {impact: $nf.impact} else {} end)
        + (if $nf.remediation then {remediation: $nf.remediation} else {} end)
        + (if $nf.owasp then {owasp: $nf.owasp} else {} end)
        + (if $nf.guide_rule then {guide_rule: $nf.guide_rule} else {} end)
      ) as $issue |
      .[$fpath] = ((.[$fpath] // []) + [$issue])
    )
) as $issues_map |

# Build file entries
[
  $issues_map | to_entries[] |
  {
    path: .key,
    issues: .value
  }
] as $files |

{
  directory: $dir,
  directories_analyzed: [$dir],
  category: $category,
  languages_found: $languages,
  purpose: "Auto-created by \($source) — run full /audit for complete analysis",
  file_count: ($files | length),
  total_lines: 0,
  files: $files,
  internal_dependencies: [],
  external_dependencies: [],
  test_coverage: "unknown",
  documentation_quality: "unknown",
  sources: [$source]
}
')

    echo "$NEW_MODULE" | jq '.' > "$module_file"
    CREATED_COUNT=$((CREATED_COUNT + 1))
  fi
done <<< "$MODULE_DIRS"

TOTAL=$((MERGED_COUNT + CREATED_COUNT))
echo "Merged findings from ${SOURCE_COMMAND}: ${TOTAL} modules affected (${CREATED_COUNT} created, ${MERGED_COUNT} updated)"

exit 0
