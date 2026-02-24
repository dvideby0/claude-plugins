#!/usr/bin/env bash
# Tests for write-audit-meta.sh
# Verifies JSON output structure, module listing, and git SHA capture.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/write-audit-meta.sh"

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

assert_match() {
  local desc="$1" pattern="$2" actual="$3"
  if echo "$actual" | grep -qE "$pattern"; then
    echo "  PASS: $desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $desc"
    echo "    expected to match: $pattern"
    echo "    actual: $actual"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ======================================================================
# Test 1: JSON output structure with known inputs
# ======================================================================
echo "=== Test 1: JSON structure with modules ==="
TMPDIR=$(mktemp -d)

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "full" "src_auth" "src_utils" "src_api" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/.audit-meta.json"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # Verify it is valid JSON
  jq '.' "$OUTPUT_FILE" >/dev/null 2>&1
  assert_eq "Output is valid JSON" "0" "$?"

  # Check audit type
  AUDIT_TYPE=$(jq -r '.last_audit_type' "$OUTPUT_FILE")
  assert_eq "Audit type is full" "full" "$AUDIT_TYPE"

  # Check modules array
  MOD_COUNT=$(jq '.modules_analyzed | length' "$OUTPUT_FILE")
  assert_eq "3 modules analyzed" "3" "$MOD_COUNT"

  FIRST_MOD=$(jq -r '.modules_analyzed[0]' "$OUTPUT_FILE")
  assert_eq "First module is src_auth" "src_auth" "$FIRST_MOD"

  # Check total_modules
  TOTAL=$(jq '.total_modules' "$OUTPUT_FILE")
  assert_eq "Total modules is 3" "3" "$TOTAL"

  # Check timestamp format (ISO 8601)
  TIMESTAMP=$(jq -r '.last_audit' "$OUTPUT_FILE")
  assert_match "Timestamp is ISO 8601" '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' "$TIMESTAMP"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Git SHA captured when in a git repo
# ======================================================================
echo "=== Test 2: Git SHA in git repo ==="
TMPDIR=$(mktemp -d)

# Initialize a git repo
cd "$TMPDIR"
git init -q
git config user.email "test@test.com"
git config user.name "Test User"
echo "test" > file.txt
git add . && git commit -q -m "initial"
EXPECTED_SHA=$(git rev-parse HEAD)
cd "$SCRIPT_DIR"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "incremental" "src_auth" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/.audit-meta.json"

GIT_SHA=$(jq -r '.git_sha' "$OUTPUT_FILE")
assert_eq "Git SHA matches HEAD" "$EXPECTED_SHA" "$GIT_SHA"

# Also check audit type is incremental
AUDIT_TYPE=$(jq -r '.last_audit_type' "$OUTPUT_FILE")
assert_eq "Audit type is incremental" "incremental" "$AUDIT_TYPE"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Git SHA is null when not in a git repo
# ======================================================================
echo "=== Test 3: Git SHA null outside git ==="
TMPDIR=$(mktemp -d)

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "full" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/.audit-meta.json"

GIT_SHA=$(jq -r '.git_sha' "$OUTPUT_FILE")
assert_eq "Git SHA is null outside git" "null" "$GIT_SHA"

# With no modules passed, modules_analyzed should be empty
MOD_COUNT=$(jq '.modules_analyzed | length' "$OUTPUT_FILE")
assert_eq "Zero modules when none passed" "0" "$MOD_COUNT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Default audit type
# ======================================================================
echo "=== Test 4: Default audit type ==="
TMPDIR=$(mktemp -d)

# Only pass project root, no audit type
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/.audit-meta.json"

AUDIT_TYPE=$(jq -r '.last_audit_type' "$OUTPUT_FILE")
assert_eq "Default audit type is full" "full" "$AUDIT_TYPE"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "write-audit-meta: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
