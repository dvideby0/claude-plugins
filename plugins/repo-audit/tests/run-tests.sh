#!/usr/bin/env bash
# Run all repo-audit tests and report results.
#
# Usage: bash run-tests.sh
# Exit: non-zero if any test suite failed

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TOTAL_SUITES=0
PASSED_SUITES=0
FAILED_SUITES=0
FAILED_NAMES=()

START_TIME=$(date +%s)

run_test() {
  local name="$1"
  local cmd="$2"
  TOTAL_SUITES=$((TOTAL_SUITES + 1))

  echo ""
  echo "================================================================"
  echo "  Running: $name"
  echo "================================================================"

  if eval "$cmd"; then
    PASSED_SUITES=$((PASSED_SUITES + 1))
  else
    FAILED_SUITES=$((FAILED_SUITES + 1))
    FAILED_NAMES+=("$name")
  fi
}

# --- Run all test suites ---

run_test "test-build-dep-graph" \
  "bash '${SCRIPT_DIR}/test-build-dep-graph.sh'"

run_test "test-compute-risk-scores" \
  "bash '${SCRIPT_DIR}/test-compute-risk-scores.sh'"

run_test "test-extract-variants" \
  "bash '${SCRIPT_DIR}/test-extract-variants.sh'"

run_test "test-extract-skeletons" \
  "python3 '${SCRIPT_DIR}/test-extract-skeletons.py'"

run_test "test-git-analysis" \
  "bash '${SCRIPT_DIR}/test-git-analysis.sh'"

run_test "test-write-audit-meta" \
  "bash '${SCRIPT_DIR}/test-write-audit-meta.sh'"

run_test "test-check-prereqs" \
  "bash '${SCRIPT_DIR}/test-check-prereqs.sh'"

# --- Summary ---

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "================================================================"
echo "  TEST SUMMARY"
echo "================================================================"
echo "  Suites: ${PASSED_SUITES}/${TOTAL_SUITES} passed"
echo "  Time:   ${ELAPSED}s"

if [ ${#FAILED_NAMES[@]} -gt 0 ]; then
  echo ""
  echo "  Failed suites:"
  for name in "${FAILED_NAMES[@]}"; do
    echo "    - $name"
  done
fi

echo "================================================================"
echo ""

[ "$FAILED_SUITES" -eq 0 ] || exit 1
