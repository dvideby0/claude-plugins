#!/usr/bin/env bash
# Tests for assemble-audit-report.sh
# Verifies report generation from module JSONs, tool output, and
# graceful handling of missing data.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/assemble-audit-report.sh"
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
# Test 1: Happy path with fixture modules
# ======================================================================
echo "=== Test 1: Happy path ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/AUDIT_REPORT.md"

assert_eq "Exit code is 0" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: AUDIT_REPORT.md not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Has title" "# Audit Report" "$CONTENT"
  assert_contains "Has findings count" "Total findings:" "$CONTENT"
  assert_contains "Has critical findings" "Critical" "$CONTENT"
  assert_contains "Has security category" "security" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Missing tool output — report still generates
# ======================================================================
echo "=== Test 2: Missing tool output ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

# Copy modules but do NOT create tool-output/ or data/ directories
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/AUDIT_REPORT.md"

assert_eq "Exit code is 0 without tool output" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Report not created without tool output"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Report has title" "# Audit Report" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Issues with missing severity/category
# ======================================================================
echo "=== Test 3: Missing severity/category ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/sdlc-audit/modules/src_bad_issues.json" <<'EOF'
{
  "directory": "src_bad_issues",
  "total_lines": 100,
  "test_coverage": "none",
  "documentation_quality": "missing",
  "internal_dependencies": [],
  "external_dependencies": [],
  "files": [{
    "path": "src/bad/file.py",
    "issues": [
      {"description": "Something is wrong"},
      {"severity": "warning", "description": "Missing category field"}
    ],
    "functions": []
  }]
}
EOF

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/AUDIT_REPORT.md"

assert_eq "Exit code is 0 with bad issues" "0" "$EXIT_CODE"

if [ -f "$OUTPUT_FILE" ]; then
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Report includes issue description" "Something is wrong" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Empty modules directory
# ======================================================================
echo "=== Test 4: Empty modules ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Empty modules exits with code 0" "0" "$EXIT_CODE"
assert_contains "Prints skip message" "No module JSONs found" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "assemble-audit-report: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
