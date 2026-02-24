#!/usr/bin/env bash
# Tests for build-dep-graph.sh
# Verifies dependency graph construction, cycle detection, fan-in/fan-out,
# hub/orphan classification, and graceful handling of empty input.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/build-dep-graph.sh"
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
    echo "    actual: $haystack"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ======================================================================
# Test 1: Happy path with cycle detection (A->B->A)
# ======================================================================
echo "=== Test 1: Cycle detection ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

# Copy cycle fixtures
cp "$FIXTURES_DIR/src_cycle_a.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_cycle_b.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/dependency-data.json"

# Verify output file exists
if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # Check cycle detection found the A<->B cycle
  CYCLE_COUNT=$(jq '.circular_dependencies | length' "$OUTPUT_FILE")
  assert_eq "Detects exactly 1 direct cycle" "1" "$CYCLE_COUNT"

  # Verify the cycle contains both modules
  CYCLE_MEMBERS=$(jq -r '.circular_dependencies[0] | join(",")' "$OUTPUT_FILE")
  assert_contains "Cycle includes src_cycle_a" "src_cycle_a" "$CYCLE_MEMBERS"
  assert_contains "Cycle includes src_cycle_b" "src_cycle_b" "$CYCLE_MEMBERS"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Fan-in/fan-out counts with 3 modules
# ======================================================================
echo "=== Test 2: Fan-in/fan-out counts ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

# src_api depends on [src_utils, src_auth]
# src_auth depends on [src_utils]
# src_utils depends on []
# So: fan-in for src_utils = 2 (from api + auth)
#     fan-in for src_auth  = 1 (from api)
#     fan-in for src_api   = 0
#     fan-out for src_api  = 2
#     fan-out for src_auth = 1
#     fan-out for src_utils = 0
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/dependency-data.json"

UTILS_FAN_IN=$(jq '.module_graph.src_utils.fan_in' "$OUTPUT_FILE")
assert_eq "src_utils fan_in = 2" "2" "$UTILS_FAN_IN"

AUTH_FAN_IN=$(jq '.module_graph.src_auth.fan_in' "$OUTPUT_FILE")
assert_eq "src_auth fan_in = 1" "1" "$AUTH_FAN_IN"

API_FAN_IN=$(jq '.module_graph.src_api.fan_in' "$OUTPUT_FILE")
assert_eq "src_api fan_in = 0" "0" "$API_FAN_IN"

API_FAN_OUT=$(jq '.module_graph.src_api.fan_out' "$OUTPUT_FILE")
assert_eq "src_api fan_out = 2" "2" "$API_FAN_OUT"

UTILS_FAN_OUT=$(jq '.module_graph.src_utils.fan_out' "$OUTPUT_FILE")
assert_eq "src_utils fan_out = 0" "0" "$UTILS_FAN_OUT"

# Verify depended_on_by for src_utils contains src_auth and src_api
UTILS_REV_DEPS=$(jq -r '.module_graph.src_utils.depended_on_by | sort | join(",")' "$OUTPUT_FILE")
assert_eq "src_utils depended_on_by = src_api,src_auth" "src_api,src_auth" "$UTILS_REV_DEPS"

# Verify external dependencies mapping
EXPRESS_USERS=$(jq -r '.external_dependencies.express | sort | join(",")' "$OUTPUT_FILE")
assert_eq "express used by src_api,src_auth" "src_api,src_auth" "$EXPRESS_USERS"

# Verify no cycles in this set
CYCLE_COUNT=$(jq '.circular_dependencies | length' "$OUTPUT_FILE")
assert_eq "No cycles in auth/utils/api set" "0" "$CYCLE_COUNT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Empty input - no module files
# ======================================================================
echo "=== Test 3: Empty input ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Empty input exits with code 0" "0" "$EXIT_CODE"
assert_contains "Empty input prints skip message" "No module JSONs found" "$OUTPUT"

# Verify no output file was created
if [ ! -f "$TMPDIR/sdlc-audit/data/dependency-data.json" ]; then
  echo "  PASS: No output file created for empty input"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: Output file should not exist for empty input"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Orphan module detection
# ======================================================================
echo "=== Test 4: Orphan module detection ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/dependency-data.json"

# src_api has fan_in=0 and fan_out=2, so it should be an orphan
ORPHANS=$(jq -r '.orphan_modules | join(",")' "$OUTPUT_FILE")
assert_contains "src_api is an orphan (fan_in=0, fan_out>0)" "src_api" "$ORPHANS"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "build-dep-graph: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
