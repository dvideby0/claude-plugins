#!/usr/bin/env bash
# repo-audit: Build dependency graph from module analysis JSONs.
#
# Reads sdlc-audit/modules/*.json, builds a module dependency graph,
# detects direct cycles, and classifies hub/orphan modules.
#
# Requires: jq
# Usage: bash build-dep-graph.sh [project-root]
# Output: sdlc-audit/data/dependency-data.json

set -o pipefail

PROJECT_ROOT="${1:-.}"
MODULES_DIR="${PROJECT_ROOT}/sdlc-audit/modules"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data"
OUTPUT_FILE="${OUTPUT_DIR}/dependency-data.json"

if ! command -v jq &>/dev/null; then
  echo "jq not available — skipping programmatic dependency graph."
  exit 0
fi

shopt -s nullglob
MODULE_FILES=("${MODULES_DIR}"/*.json)
shopt -u nullglob

if [ ${#MODULE_FILES[@]} -eq 0 ]; then
  echo "No module JSONs found — skipping dependency graph."
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

# Step 1: Extract deps from each module into a single merged object
# { "module_name": { "depends_on": [...], "external": [...] }, ... }
MERGED=$(jq -s '
  [.[] | {
    key: (.directory // input_filename | gsub(".*/"; "") | gsub("\\.json$"; "")),
    value: {
      depends_on: (.internal_dependencies // []),
      external: (.external_dependencies // [])
    }
  }] | from_entries
' "${MODULE_FILES[@]}" 2>/dev/null)

if [ -z "$MERGED" ] || [ "$MERGED" = "null" ]; then
  echo "Failed to parse module JSONs — skipping dependency graph."
  exit 0
fi

# Step 2: Build full graph with fan-in, fan-out, reverse deps, cycle detection
jq -n --argjson modules "$MERGED" '
# Build reverse dependency map
def reverse_deps:
  . as $mods |
  reduce (keys[] | . as $mod | $mods[$mod].depends_on[] | {dep: ., mod: $mod}) as $pair
    ({}; .[$pair.dep] += [$pair.mod]);

# Detect direct cycles (A->B and B->A)
def direct_cycles:
  . as $mods |
  [keys[] | . as $a |
    $mods[$a].depends_on[] | . as $b |
    select($mods[$b].depends_on // [] | index($a)) |
    if $a < $b then [$a, $b, $a] else empty end
  ] | unique;

$modules | reverse_deps as $rev |
$modules | direct_cycles as $cycles |

# Compute fan-in values
[($rev | values | .[] )] as $all_rev |
([$modules | keys[] | {key: ., value: (($rev[.] // []) | length)}] | from_entries) as $fan_ins |

# Median fan-in
([$fan_ins[]] | sort | .[length / 2 | floor]) as $median |

# Hub modules: fan_in > max(median*2, 2)
(if $median * 2 > 2 then $median * 2 else 2 end) as $hub_threshold |
[$fan_ins | to_entries[] | select(.value > $hub_threshold) | .key] as $hubs |

# Orphan modules: fan_in=0 but fan_out>0
[$modules | keys[] | select(
  ($fan_ins[.] // 0) == 0 and (($modules[.].depends_on // []) | length) > 0
)] as $orphans |

# External dependency inventory
(reduce ($modules | keys[]) as $mod
  ({}; . as $acc | reduce ($modules[$mod].external[]) as $dep
    ($acc; .[$dep] += [$mod])
  )
) as $ext_map |

# Build module_graph
(reduce ($modules | keys[]) as $mod
  ({};
    .[$mod] = {
      depends_on: $modules[$mod].depends_on,
      depended_on_by: ($rev[$mod] // []),
      fan_in: ($fan_ins[$mod] // 0),
      fan_out: (($modules[$mod].depends_on // []) | length),
      external_deps: $modules[$mod].external
    }
  )
) as $graph |

{
  module_graph: $graph,
  circular_dependencies: $cycles,
  hub_modules: $hubs,
  orphan_modules: $orphans,
  external_dependencies: $ext_map
}
' > "$OUTPUT_FILE"

# Print summary
MCOUNT=$(jq '.module_graph | keys | length' "$OUTPUT_FILE" 2>/dev/null)
MCOUNT="${MCOUNT:-0}"
CCOUNT=$(jq '.circular_dependencies | length' "$OUTPUT_FILE" 2>/dev/null)
CCOUNT="${CCOUNT:-0}"
HCOUNT=$(jq '.hub_modules | length' "$OUTPUT_FILE" 2>/dev/null)
HCOUNT="${HCOUNT:-0}"
echo "Graph: ${MCOUNT} modules, ${CCOUNT} cycles, ${HCOUNT} hubs"
echo "Wrote: ${OUTPUT_FILE}"
