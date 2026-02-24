#!/usr/bin/env bash
# repo-audit: Git history analysis
# Produces hotspot data and bus factor analysis.
#
# Usage: bash git-analysis.sh [project-root]
# Output: sdlc-audit/data/git-hotspots.txt, sdlc-audit/data/git-busfactor.txt

set -o pipefail

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data"

if [ ! -d "${PROJECT_ROOT}/.git" ]; then
  echo "Not a git repository — skipping git analysis."
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

# --- Hotspots: most-changed files in last 6 months ---
{
  echo '{"hotspots": ['
  git -C "$PROJECT_ROOT" log --format=format: --name-only --since="6 months ago" 2>/dev/null \
    | grep -v '^$' \
    | sort | uniq -c | sort -rn | head -30 \
    | awk '{if(NR>1) printf ",\n"; printf "  {\"changes\": %d, \"file\": \"%s\"}", $1, $2}'
  echo ''
  echo ']}'
} > "${OUTPUT_DIR}/git-hotspots.txt"

# --- Bus factor: contributors per top-level directory ---
{
  echo "=== BUS FACTOR ==="
  for dir in $(find "$PROJECT_ROOT" -mindepth 1 -maxdepth 1 -type d -not -name '.git' -not -name 'node_modules' -not -name 'sdlc-audit' | sort); do
    reldir="${dir#$PROJECT_ROOT/}"
    echo "--- ${reldir} ---"
    git -C "$PROJECT_ROOT" shortlog -sn HEAD -- "$reldir" 2>/dev/null | head -3
  done

  # Recent commit count
  COMMIT_COUNT=$(git -C "$PROJECT_ROOT" rev-list --count --since="6 months ago" HEAD 2>/dev/null || echo "0")
  echo ""
  echo "Total commits (6mo): ${COMMIT_COUNT}"
} > "${OUTPUT_DIR}/git-busfactor.txt"

echo "Wrote: ${OUTPUT_DIR}/git-hotspots.txt"
echo "Wrote: ${OUTPUT_DIR}/git-busfactor.txt"
