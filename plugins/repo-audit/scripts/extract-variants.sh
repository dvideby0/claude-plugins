#!/usr/bin/env bash
# repo-audit: Extract variant analysis candidates from module JSONs.
#
# Reads all module analysis results, extracts critical/warning issues,
# groups them by guide_rule to identify recurring patterns, and flags
# systemic patterns (same issue across 3+ directories).
#
# Requires: jq
# Usage: bash extract-variants.sh [project-root]
# Output: sdlc-audit/data/variant-candidates.json

set -o pipefail

PROJECT_ROOT="${1:-.}"
MODULES_DIR="${PROJECT_ROOT}/sdlc-audit/modules"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data"
OUTPUT_FILE="${OUTPUT_DIR}/variant-candidates.json"

if ! command -v jq &>/dev/null; then
  echo "jq not available — skipping programmatic variant extraction."
  exit 0
fi

shopt -s nullglob
MODULE_FILES=("${MODULES_DIR}"/*.json)
shopt -u nullglob

if [ ${#MODULE_FILES[@]} -eq 0 ]; then
  echo "No module JSONs found — skipping variant extraction."
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

jq -s '
# Flatten all critical/warning issues from all modules
[.[] | .files[]? | . as $file |
  .issues[]? | select(.severity == "critical" or .severity == "warning") |
  {
    category: (.category // ""),
    description: (.description // ""),
    file: ($file.path // ""),
    line_range: .line_range,
    guide_rule: (.guide_rule // ""),
    severity: .severity
  }
] |

# Total count
length as $total |

# Category distribution
(group_by(.category) | map({key: .[0].category, value: length}) | from_entries) as $cat_dist |

# Group by guide_rule (only issues that have one)
[.[] | select(.guide_rule != "")] | group_by(.guide_rule) |

# Systemic: same rule triggered in 3+ different directories
(map(select(
  [.[].file | split("/")[:-1] | join("/")] | unique | length >= 3
)) | map({
  key: .[0].guide_rule,
  value: {
    count: length,
    files: [.[].file],
    directories: ([.[].file | split("/")[:-1] | join("/")] | unique),
    severity: .[0].severity,
    category: .[0].category
  }
}) | from_entries) as $systemic |

# Single critical: appeared exactly once, worth variant searching
(map(select(
  length == 1 and .[0].severity == "critical"
)) | map({
  key: .[0].guide_rule,
  value: .[0]
}) | from_entries) as $single |

{
  systemic_patterns: $systemic,
  single_critical: $single,
  category_distribution: $cat_dist,
  total_high_severity: $total
}
' "${MODULE_FILES[@]}" > "$OUTPUT_FILE"

# Print summary
TOTAL=$(jq '.total_high_severity' "$OUTPUT_FILE" 2>/dev/null)
TOTAL="${TOTAL:-0}"
SYS=$(jq '.systemic_patterns | keys | length' "$OUTPUT_FILE" 2>/dev/null)
SYS="${SYS:-0}"
SINGLE=$(jq '.single_critical | keys | length' "$OUTPUT_FILE" 2>/dev/null)
SINGLE="${SINGLE:-0}"
echo "Issues: ${TOTAL} total, ${SYS} systemic patterns, ${SINGLE} single-critical for variant search"
echo "Wrote: ${OUTPUT_FILE}"
