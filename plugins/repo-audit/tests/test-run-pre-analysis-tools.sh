#!/usr/bin/env bash
# Tests for run-pre-analysis-tools.sh
# Regression tests for production bug: sibling parallel Bash calls killed
# when any tool exits non-zero. Verifies the script always exits 0 and
# logs failures to a debug file.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/run-pre-analysis-tools.sh"

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
# Test 1: Script always exits 0 with no tools available
# ======================================================================
echo "=== Test 1: Always exits 0 ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"

# Create tool-availability.json with everything unavailable
cat > "$TMPDIR/sdlc-audit/data/tool-availability.json" <<'EOF'
{
  "tools": {
    "cloc": {"available": false, "path": ""},
    "tokei": {"available": false, "path": ""}
  }
}
EOF

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Exit code is 0 with no tools" "0" "$EXIT_CODE"
assert_contains "Shows completion message" "Pre-Analysis Complete" "$OUTPUT"

# Failure log should exist
FAIL_LOG="$TMPDIR/sdlc-audit/data/pre-analysis-failures.log"
if [ -f "$FAIL_LOG" ]; then
  echo "  PASS: Failure log created"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: Failure log not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Failure log is populated when tool fails
# ======================================================================
echo "=== Test 2: Failure logging ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"

# Create a fake .git directory (not a real repo) to trigger git-analysis
# which will likely fail since there's no actual git repo
mkdir -p "$TMPDIR/.git"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Exit code is 0 even with failures" "0" "$EXIT_CODE"

FAIL_LOG="$TMPDIR/sdlc-audit/data/pre-analysis-failures.log"
FAIL_LOG_CONTENT=$(cat "$FAIL_LOG" 2>/dev/null)

# The log header should always be present
assert_contains "Failure log has header" "Pre-Analysis Failure Log" "$FAIL_LOG_CONTENT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Skipped tools reported in output
# ======================================================================
echo "=== Test 3: Skipped tools ==="
TMPDIR=$(mktemp -d)
# No package.json, no go.mod, no tsconfig.json, no .git

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)

assert_contains "Reports eslint skip" "SKIP" "$OUTPUT"
assert_contains "Reports tsc skip" "tsc" "$OUTPUT"
assert_contains "Reports npm-audit skip" "npm-audit" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Missing tool-availability.json falls back to command -v
# ======================================================================
echo "=== Test 4: Missing tool-availability.json ==="
TMPDIR=$(mktemp -d)
# Do NOT create tool-availability.json — script should use command -v fallback

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Exit code is 0 without tool-availability.json" "0" "$EXIT_CODE"
assert_contains "Script completes" "Pre-Analysis Complete" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 5: Success and fail counts in summary
# ======================================================================
echo "=== Test 5: Summary counts ==="
TMPDIR=$(mktemp -d)

# Set up a real git repo so git-analysis succeeds
git -C "$TMPDIR" init -q 2>/dev/null
git -C "$TMPDIR" config user.email "test@test.com" 2>/dev/null
git -C "$TMPDIR" config user.name "Test" 2>/dev/null
echo "test" > "$TMPDIR/file.txt"
git -C "$TMPDIR" add file.txt 2>/dev/null
git -C "$TMPDIR" commit -m "init" -q 2>/dev/null

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)

assert_match "Shows succeeded count" "Succeeded: [0-9]+" "$OUTPUT"
assert_match "Shows failed count" "Failed: [0-9]+" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "run-pre-analysis-tools: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
