#!/usr/bin/env bash
# Edge-case tests for build-dep-graph.sh
# Regression tests for production bug: "Cannot index object with object"
# when LLM sub-agents emit object-typed dependencies instead of strings.

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
# Test 1: Object-typed dependencies are normalized to strings
# ======================================================================
echo "=== Test 1: Object-typed dependencies ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_obj_deps.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/dependency-data.json"

assert_eq "Exit code is 0" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # Object deps should be normalized to strings
  DEP_COUNT=$(jq '.module_graph.src_obj_deps.fan_out' "$OUTPUT_FILE")
  assert_eq "src_obj_deps fan_out = 2" "2" "$DEP_COUNT"

  DEPS=$(jq -r '.module_graph.src_obj_deps.depends_on | sort | join(",")' "$OUTPUT_FILE")
  assert_eq "Dependencies normalized to strings" "src_auth,src_utils" "$DEPS"

  # Object external deps should also be normalized
  AXIOS_USERS=$(jq -r '.external_dependencies.axios // [] | join(",")' "$OUTPUT_FILE")
  assert_contains "axios external dep tracked" "src_obj_deps" "$AXIOS_USERS"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Directory names with slashes work as graph keys
# ======================================================================
echo "=== Test 2: Directory with slashes ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_slash_dir.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/dependency-data.json"

# jq can handle keys with slashes using bracket notation
SLASH_EXISTS=$(jq '.module_graph["src/slash_dir"] != null' "$OUTPUT_FILE")
assert_eq "Module with slashes exists in graph" "true" "$SLASH_EXISTS"

SLASH_FAN_OUT=$(jq '.module_graph["src/slash_dir"].fan_out' "$OUTPUT_FILE")
assert_eq "src/slash_dir fan_out = 1" "1" "$SLASH_FAN_OUT"

UTILS_REV=$(jq -r '.module_graph.src_utils.depended_on_by | join(",")' "$OUTPUT_FILE")
assert_contains "src_utils depended_on_by includes src/slash_dir" "src/slash_dir" "$UTILS_REV"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Missing directory field defaults to "unknown"
# ======================================================================
echo "=== Test 3: Missing directory field ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_no_dir.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/dependency-data.json"

UNKNOWN_EXISTS=$(jq '.module_graph.unknown != null' "$OUTPUT_FILE")
assert_eq "Missing directory defaults to 'unknown'" "true" "$UNKNOWN_EXISTS"

KEY_COUNT=$(jq '.module_graph | keys | length' "$OUTPUT_FILE")
assert_eq "Graph has 1 module" "1" "$KEY_COUNT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Self-referencing dep does not create false cycle
# ======================================================================
echo "=== Test 4: Self-referencing dependency ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_self_ref.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/dependency-data.json"

CYCLE_COUNT=$(jq '.circular_dependencies | length' "$OUTPUT_FILE")
assert_eq "Self-reference does not create cycle" "0" "$CYCLE_COUNT"

# Self-ref counts in fan_out (it depends on itself + src_utils)
SELF_FAN_OUT=$(jq '.module_graph.src_self_ref.fan_out' "$OUTPUT_FILE")
assert_eq "src_self_ref fan_out = 2 (self + utils)" "2" "$SELF_FAN_OUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 5: Malformed JSON module file handled gracefully
# ======================================================================
echo "=== Test 5: Malformed JSON ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

echo "{invalid json content" > "$TMPDIR/sdlc-audit/modules/broken.json"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Malformed JSON exits with code 0" "0" "$EXIT_CODE"
assert_contains "Prints failure message" "Failed to parse" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "build-dep-graph edge cases: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
