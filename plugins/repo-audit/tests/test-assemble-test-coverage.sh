#!/usr/bin/env bash
# Tests for assemble-test-coverage.sh
# Verifies TEST_COVERAGE_MAP.md generation with mixed coverage levels.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/assemble-test-coverage.sh"
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

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if ! echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $desc (should NOT contain: $needle)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ======================================================================
# Test 1: Happy path with mixed coverage levels
# ======================================================================
echo "=== Test 1: Mixed coverage levels ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

# src_api=none, src_auth=partial, src_utils=full
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/TEST_COVERAGE_MAP.md"

assert_eq "Exit code is 0" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: TEST_COVERAGE_MAP.md not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Has title" "# Test Coverage Map" "$CONTENT"
  assert_contains "Has coverage table" "Coverage by Module" "$CONTENT"
  assert_contains "Has untested section" "Untested Modules" "$CONTENT"
  assert_contains "Lists untested module" "src_api" "$CONTENT"
  assert_contains "Has partial section" "Partially Tested" "$CONTENT"
  assert_contains "Lists partial module" "src_auth" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Critical untested paths with risk data
# ======================================================================
echo "=== Test 2: Risk-annotated critical paths ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$REPO_ROOT/scripts/build-dep-graph.sh" "$TMPDIR" >/dev/null 2>&1
bash "$REPO_ROOT/scripts/compute-risk-scores.sh" "$TMPDIR" >/dev/null 2>&1

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/TEST_COVERAGE_MAP.md"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Report not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Has critical untested section" "Critical Untested Paths" "$CONTENT"
  assert_contains "Shows risk annotation" "risk:" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Report generates without risk-scores.json
# ======================================================================
echo "=== Test 3: No risk scores ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/TEST_COVERAGE_MAP.md"

assert_eq "Exit code is 0 without risk scores" "0" "$EXIT_CODE"

if [ -f "$OUTPUT_FILE" ]; then
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Has critical untested section" "Critical Untested Paths" "$CONTENT"
  assert_contains "Lists untested module" "src_api" "$CONTENT"
  assert_not_contains "No risk annotation" "risk:" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "assemble-test-coverage: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
