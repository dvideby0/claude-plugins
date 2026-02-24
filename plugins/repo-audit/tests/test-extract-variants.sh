#!/usr/bin/env bash
# Tests for extract-variants.sh
# Verifies systemic pattern detection, single-critical extraction,
# category distribution, and graceful handling of no-issue modules.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/extract-variants.sh"
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
# Test 1: Systemic pattern detection (same rule in 3+ directories)
# ======================================================================
echo "=== Test 1: Systemic pattern detection ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

# DRY-001-no-duplicate-logic appears in:
#   src/auth/permissions.py (dir: src/auth)
#   src/utils/helpers.py    (dir: src/utils)
#   src/api/routes.py       (dir: src/api)
# That's 3 different directories -> systemic pattern
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/variant-candidates.json"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # DRY-001 should be flagged as systemic (3 dirs)
  HAS_DRY=$(jq 'has("systemic_patterns") and (.systemic_patterns | has("DRY-001-no-duplicate-logic"))' "$OUTPUT_FILE")
  assert_eq "DRY-001 detected as systemic pattern" "true" "$HAS_DRY"

  # Verify the count of DRY-001 occurrences
  DRY_COUNT=$(jq '.systemic_patterns["DRY-001-no-duplicate-logic"].count' "$OUTPUT_FILE")
  assert_eq "DRY-001 appears 3 times" "3" "$DRY_COUNT"

  # Verify directories listed
  DRY_DIRS=$(jq '.systemic_patterns["DRY-001-no-duplicate-logic"].directories | length' "$OUTPUT_FILE")
  assert_eq "DRY-001 spans 3 directories" "3" "$DRY_DIRS"

  # Verify total_high_severity count
  # From our fixtures: auth has 4 issues (1 crit, 3 warn), utils has 1 warn, api has 3 (1 crit, 2 warn)
  # Total critical+warning = 4 + 1 + 3 = 8
  TOTAL=$(jq '.total_high_severity' "$OUTPUT_FILE")
  assert_eq "Total high severity issues = 8" "8" "$TOTAL"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Single-critical extraction
# ======================================================================
echo "=== Test 2: Single-critical extraction ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/variant-candidates.json"

# SEC-001 (hardcoded secrets) appears only once -> single_critical
HAS_SEC001=$(jq '.single_critical | has("SEC-001-no-hardcoded-secrets")' "$OUTPUT_FILE")
assert_eq "SEC-001 is a single critical" "true" "$HAS_SEC001"

# SEC-002 (input validation) appears only once -> single_critical
HAS_SEC002=$(jq '.single_critical | has("SEC-002-input-validation")' "$OUTPUT_FILE")
assert_eq "SEC-002 is a single critical" "true" "$HAS_SEC002"

# Verify single_critical entries have proper structure
SEC001_SEV=$(jq -r '.single_critical["SEC-001-no-hardcoded-secrets"].severity' "$OUTPUT_FILE")
assert_eq "SEC-001 severity is critical" "critical" "$SEC001_SEV"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Category distribution
# ======================================================================
echo "=== Test 3: Category distribution ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/variant-candidates.json"

# Verify category_distribution exists and has security + maintainability
HAS_SECURITY=$(jq '.category_distribution | has("security")' "$OUTPUT_FILE")
assert_eq "Category distribution has security" "true" "$HAS_SECURITY"

HAS_MAINT=$(jq '.category_distribution | has("maintainability")' "$OUTPUT_FILE")
assert_eq "Category distribution has maintainability" "true" "$HAS_MAINT"

# security issues: SEC-001 (1) + SEC-005 (2) + SEC-003 (1) + SEC-002 (1) = 5
SECURITY_COUNT=$(jq '.category_distribution.security' "$OUTPUT_FILE")
assert_eq "5 security issues" "5" "$SECURITY_COUNT"

# maintainability issues: DRY-001 (3) = 3
MAINT_COUNT=$(jq '.category_distribution.maintainability' "$OUTPUT_FILE")
assert_eq "3 maintainability issues" "3" "$MAINT_COUNT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Modules with no critical/warning issues
# ======================================================================
echo "=== Test 4: No issues modules ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

# Create a module with no issues at all
cat > "$TMPDIR/sdlc-audit/modules/src_clean.json" << 'FIXTURE'
{
  "directory": "src_clean",
  "total_lines": 100,
  "test_coverage": "full",
  "documentation_quality": "comprehensive",
  "internal_dependencies": [],
  "external_dependencies": [],
  "files": [
    {
      "path": "src/clean/main.py",
      "issues": [],
      "functions": [{"name": "main", "complexity": "low"}]
    }
  ]
}
FIXTURE

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/variant-candidates.json"

TOTAL=$(jq '.total_high_severity' "$OUTPUT_FILE")
assert_eq "Zero high severity issues" "0" "$TOTAL"

SYSTEMIC=$(jq '.systemic_patterns | keys | length' "$OUTPUT_FILE")
assert_eq "No systemic patterns" "0" "$SYSTEMIC"

SINGLE=$(jq '.single_critical | keys | length' "$OUTPUT_FILE")
assert_eq "No single criticals" "0" "$SINGLE"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "extract-variants: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
