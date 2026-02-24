#!/usr/bin/env bash
# Tests for validate-module-json.sh
# Verifies schema validation catches invalid module JSONs and passes valid ones.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/validate-module-json.sh"
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
# Test 1: Valid module passes validation
# ======================================================================
echo "=== Test 1: Valid module passes ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_valid_full.json" "$TMPDIR/sdlc-audit/modules/"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Valid module exits 0" "0" "$EXIT_CODE"

RESULT_FILE="$TMPDIR/sdlc-audit/data/validation-results.json"
PASSED=$(jq '.passed' "$RESULT_FILE")
FAILED_CT=$(jq '.failed' "$RESULT_FILE")
assert_eq "1 module passed" "1" "$PASSED"
assert_eq "0 modules failed" "0" "$FAILED_CT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Missing directory field detected
# ======================================================================
echo "=== Test 2: Missing directory field ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_no_dir.json" "$TMPDIR/sdlc-audit/modules/"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Missing directory exits 1" "1" "$EXIT_CODE"

RESULT_FILE="$TMPDIR/sdlc-audit/data/validation-results.json"
FAILED_CT=$(jq '.failed' "$RESULT_FILE")
assert_eq "1 module failed" "1" "$FAILED_CT"

ERROR_TEXT=$(jq -r '.errors[0].errors[]' "$RESULT_FILE" 2>/dev/null | tr '\n' ' ')
assert_contains "Error mentions missing directory" "Missing required field: directory" "$ERROR_TEXT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Invalid severity value detected
# ======================================================================
echo "=== Test 3: Invalid severity value ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_bad_severity.json" "$TMPDIR/sdlc-audit/modules/"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Bad severity exits 1" "1" "$EXIT_CODE"

RESULT_FILE="$TMPDIR/sdlc-audit/data/validation-results.json"
ERROR_TEXT=$(jq -r '.errors[0].errors[]' "$RESULT_FILE" 2>/dev/null | tr '\n' ' ')
assert_contains "Error mentions invalid severity" "Invalid severity" "$ERROR_TEXT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Null files field detected
# ======================================================================
echo "=== Test 4: Null files field ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_null_files.json" "$TMPDIR/sdlc-audit/modules/"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Null files exits 1" "1" "$EXIT_CODE"

RESULT_FILE="$TMPDIR/sdlc-audit/data/validation-results.json"
ERROR_TEXT=$(jq -r '.errors[0].errors[]' "$RESULT_FILE" 2>/dev/null | tr '\n' ' ')
assert_contains "Error mentions files must be array" "must be an array" "$ERROR_TEXT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 5: Missing issues in file entry detected
# ======================================================================
echo "=== Test 5: Missing issues in file entry ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_missing_issues.json" "$TMPDIR/sdlc-audit/modules/"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Missing issues exits 1" "1" "$EXIT_CODE"

RESULT_FILE="$TMPDIR/sdlc-audit/data/validation-results.json"
ERROR_TEXT=$(jq -r '.errors[0].errors[]' "$RESULT_FILE" 2>/dev/null | tr '\n' ' ')
assert_contains "Error mentions missing issues" "missing required field: issues" "$ERROR_TEXT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 6: Empty modules directory
# ======================================================================
echo "=== Test 6: Empty modules directory ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Empty dir exits 0" "0" "$EXIT_CODE"
assert_contains "Prints nothing to validate" "nothing to validate" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 7: Mix of valid and invalid modules
# ======================================================================
echo "=== Test 7: Mix of valid and invalid ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_valid_full.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_bad_severity.json" "$TMPDIR/sdlc-audit/modules/"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Mix exits 1 (has failures)" "1" "$EXIT_CODE"

RESULT_FILE="$TMPDIR/sdlc-audit/data/validation-results.json"
VALIDATED=$(jq '.validated' "$RESULT_FILE")
PASSED=$(jq '.passed' "$RESULT_FILE")
FAILED_CT=$(jq '.failed' "$RESULT_FILE")
assert_eq "2 modules validated" "2" "$VALIDATED"
assert_eq "1 module passed" "1" "$PASSED"
assert_eq "1 module failed" "1" "$FAILED_CT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "validate-module-json: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
