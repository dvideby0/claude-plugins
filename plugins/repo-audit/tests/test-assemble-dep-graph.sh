#!/usr/bin/env bash
# Tests for assemble-dep-graph.sh
# Verifies DEPENDENCY_GRAPH.md generation from dependency-data.json.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/assemble-dep-graph.sh"
DEP_GRAPH_SCRIPT="${REPO_ROOT}/scripts/build-dep-graph.sh"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures/modules"

PASS_COUNT=0
FAIL_COUNT=0
TMPDIR=""

cleanup() {
  [ -n "$TMPDIR" ] && rm -rf "$TMPDIR"
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $desc"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $desc"
    echo "    expected to contain: $needle"
    echo "    actual: $(echo "$haystack" | head -5)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ======================================================================
# Test 1: Happy path with valid dependency-data.json
# ======================================================================
echo "=== Test 1: Happy path ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

# Build dependency graph first
bash "$DEP_GRAPH_SCRIPT" "$TMPDIR" >/dev/null 2>&1

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/DEPENDENCY_GRAPH.md"

assert_eq "Exit code is 0" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: DEPENDENCY_GRAPH.md not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Has title" "# Dependency Graph" "$CONTENT"
  assert_contains "Has internal deps section" "Internal Dependencies" "$CONTENT"
  assert_contains "Has external deps section" "External Dependencies" "$CONTENT"
  assert_contains "Lists src_api" "src_api" "$CONTENT"
  assert_contains "Lists express package" "express" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Missing dependency-data.json exits 0
# ======================================================================
echo "=== Test 2: Missing dependency-data.json ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Missing dep data exits with code 0" "0" "$EXIT_CODE"
assert_contains "Prints skip message" "not found" "$OUTPUT"

# Report should NOT be created
if [ ! -f "$TMPDIR/sdlc-audit/reports/DEPENDENCY_GRAPH.md" ]; then
  echo "  PASS: No report created when data is missing"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: Report should not be created without data"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Cycles and orphans appear in report
# ======================================================================
echo "=== Test 3: Cycles and orphans ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_cycle_a.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_cycle_b.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$DEP_GRAPH_SCRIPT" "$TMPDIR" >/dev/null 2>&1
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/DEPENDENCY_GRAPH.md"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Report not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Has circular deps section" "Circular Dependencies" "$CONTENT"
  assert_contains "Lists cycle module" "src_cycle_a" "$CONTENT"
  assert_contains "Has orphan section" "Orphan" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "assemble-dep-graph: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
