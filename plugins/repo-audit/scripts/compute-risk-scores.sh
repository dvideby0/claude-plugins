#!/usr/bin/env bash
# repo-audit: Compute per-module risk scores.
#
# Formula: risk = (blast_radius * complexity) / safety_net
#   blast_radius: fan-in from dependency graph
#   complexity:   total_lines + weighted_issue_count + (high_complexity_functions * 2)
#   safety_net:   test_coverage_score + documentation_quality_score
#
# Issues are weighted by confidence level (see schemas/enums.json):
#   definite=1.0, high=0.8, medium=0.5, low=0.2, missing=0.5
#
# Requires: jq
# Usage: bash compute-risk-scores.sh [project-root]
# Output: sdlc-audit/data/risk-scores.json

set -o pipefail

PROJECT_ROOT="${1:-.}"
MODULES_DIR="${PROJECT_ROOT}/sdlc-audit/modules"
DEP_FILE="${PROJECT_ROOT}/sdlc-audit/data/dependency-data.json"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data"
OUTPUT_FILE="${OUTPUT_DIR}/risk-scores.json"

shopt -s nullglob
MODULE_FILES=("${MODULES_DIR}"/*.json)
shopt -u nullglob

if [ ${#MODULE_FILES[@]} -eq 0 ]; then
  echo "No module JSONs found — skipping risk scoring."
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

# Load dependency graph fan-in data (may not exist or may be invalid)
DEP_GRAPH="{}"
if [ -f "$DEP_FILE" ] && [ -s "$DEP_FILE" ]; then
  _tmp=$(jq '.module_graph // {}' "$DEP_FILE" 2>/dev/null)
  # Validate it's non-empty and actual JSON before using it
  if [ -n "$_tmp" ] && echo "$_tmp" | jq empty 2>/dev/null; then
    DEP_GRAPH="$_tmp"
  fi
fi

# Process all modules and compute scores
jq -s --argjson graph "$DEP_GRAPH" '
# Score mappings
def tc_score:
  {"full": 3, "partial": 2, "none": 0.5, "not-applicable": 1}[.] // 0.5;
def dq_score:
  {"comprehensive": 3, "adequate": 2, "sparse": 1, "missing": 0.5}[.] // 0.5;

# Score each module
[.[] | {
  module: (.directory // "unknown"),
  total_lines: (.total_lines // 0),
  issue_count: ([.files[]?.issues[]?] | length),
  weighted_issue_count: ([.files[]?.issues[]? |
    (if .confidence == "definite" then 1.0
     elif .confidence == "high" then 0.8
     elif .confidence == "medium" then 0.5
     elif .confidence == "low" then 0.2
     else 0.5 end)
  ] | add // 0 | . * 10 | round / 10),
  high_complexity: ([.files[]?.functions[]? | select(.complexity == "high")] | length),
  test_coverage: (.test_coverage // "unknown"),
  documentation_quality: (.documentation_quality // "unknown"),
  fan_in: ($graph[.directory // ""]?.fan_in // 0)
} | . + {
  blast_radius: ([.fan_in, 1] | max),
  complexity: (.total_lines + .weighted_issue_count + (.high_complexity * 2)),
  safety_net: ((.test_coverage | tc_score) + (.documentation_quality | dq_score))
} | . + {
  risk_score: ((.blast_radius * .complexity) / ([.safety_net, 0.5] | max) | . * 10 | round / 10)
}] |

# Sort by risk descending
sort_by(-.risk_score) |

# Percentile-based categories
(map(.risk_score) | sort) as $vals |
($vals | length) as $n |
(if $n > 1 then $vals[($n * 0.9 | floor)] else $vals[0] // 0 end) as $p90 |
(if $n > 1 then $vals[($n * 0.75 | floor)] else $vals[0] // 0 end) as $p75 |
(if $n > 1 then $vals[($n * 0.5 | floor)] else $vals[0] // 0 end) as $p50 |

{
  scores: .,
  top_10_highest_risk: .[:10] | map(.module),
  risk_distribution: {
    critical: [.[] | select(.risk_score >= $p90)] | length,
    high:     [.[] | select(.risk_score >= $p75 and .risk_score < $p90)] | length,
    medium:   [.[] | select(.risk_score >= $p50 and .risk_score < $p75)] | length,
    low:      [.[] | select(.risk_score < $p50)] | length
  }
}
' "${MODULE_FILES[@]}" > "$OUTPUT_FILE"

# Print summary
SCORED=$(jq '.scores | length' "$OUTPUT_FILE" 2>/dev/null)
SCORED="${SCORED:-0}"
TOP3=$(jq -r '.top_10_highest_risk[:3] | join(", ")' "$OUTPUT_FILE" 2>/dev/null)
TOP3="${TOP3:-none}"
echo "Scored ${SCORED} modules. Top risk: ${TOP3}"
echo "Wrote: ${OUTPUT_FILE}"

exit 0
