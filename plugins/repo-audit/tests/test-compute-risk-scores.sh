#!/usr/bin/env bash
# Tests for compute-risk-scores.sh
# Verifies risk formula, percentile-based categories, and graceful
# handling when dependency data is absent.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/compute-risk-scores.sh"
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

assert_gt() {
  local desc="$1" val="$2" threshold="$3"
  # Use awk for float comparison (portable)
  if awk "BEGIN { exit !($val > $threshold) }"; then
    echo "  PASS: $desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $desc (expected $val > $threshold)"
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
# Test 1: Happy path - verify risk formula for known inputs
# ======================================================================
echo "=== Test 1: Risk formula with dependency data ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"
mkdir -p "$TMPDIR/sdlc-audit/data"

cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

# First build the dependency graph (needed for fan-in data)
bash "$REPO_ROOT/scripts/build-dep-graph.sh" "$TMPDIR" >/dev/null 2>&1

# Now compute risk scores
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # Verify all 3 modules are scored
  SCORED_COUNT=$(jq '.scores | length' "$OUTPUT_FILE")
  assert_eq "All 3 modules scored" "3" "$SCORED_COUNT"

  # Verify scores are sorted descending
  FIRST_SCORE=$(jq '.scores[0].risk_score' "$OUTPUT_FILE")
  LAST_SCORE=$(jq '.scores[-1].risk_score' "$OUTPUT_FILE")
  assert_gt "Scores sorted descending" "$FIRST_SCORE" "$LAST_SCORE"

  # src_api: total_lines=1200, issue_count=3, high_complexity_functions=2
  #   complexity = 1200 + 3 + (2*2) = 1207
  #   test_coverage = "none" -> 0.5, doc_quality = "missing" -> 0.5
  #   safety_net = 0.5 + 0.5 = 1.0
  #   fan_in for src_api = 0, blast_radius = max(0, 1) = 1
  #   risk = (1 * 1207) / 1.0 = 1207.0
  API_SCORE=$(jq '[.scores[] | select(.module == "src_api")] | .[0].risk_score' "$OUTPUT_FILE")
  assert_eq "src_api risk score = 1207" "1207" "$API_SCORE"

  # src_utils: total_lines=420, issue_count=1, high_complexity=0
  #   complexity = 420 + 1 + 0 = 421
  #   test_coverage = "full" -> 3, doc_quality = "adequate" -> 2
  #   safety_net = 3 + 2 = 5.0
  #   fan_in = 2, blast_radius = max(2, 1) = 2
  #   risk = (2 * 421) / 5.0 = 168.4
  UTILS_SCORE=$(jq '[.scores[] | select(.module == "src_utils")] | .[0].risk_score' "$OUTPUT_FILE")
  assert_eq "src_utils risk score = 168.4" "168.4" "$UTILS_SCORE"

  # Verify top_10_highest_risk is populated
  TOP_RISK=$(jq '.top_10_highest_risk | length' "$OUTPUT_FILE")
  assert_eq "top_10_highest_risk has 3 entries" "3" "$TOP_RISK"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Percentile-based risk distribution
# ======================================================================
echo "=== Test 2: Risk distribution categories ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"
mkdir -p "$TMPDIR/sdlc-audit/data"

cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$REPO_ROOT/scripts/build-dep-graph.sh" "$TMPDIR" >/dev/null 2>&1
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

# Verify distribution categories exist and sum to total modules
DIST_SUM=$(jq '.risk_distribution | (.critical + .high + .medium + .low)' "$OUTPUT_FILE")
assert_eq "Distribution sums to total modules" "3" "$DIST_SUM"

# Verify risk_distribution has all 4 keys
HAS_CRITICAL=$(jq 'has("risk_distribution") and (.risk_distribution | has("critical"))' "$OUTPUT_FILE")
assert_eq "Has critical category" "true" "$HAS_CRITICAL"

HAS_LOW=$(jq '.risk_distribution | has("low")' "$OUTPUT_FILE")
assert_eq "Has low category" "true" "$HAS_LOW"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: No dependency data file - fan-in defaults to 0
# ======================================================================
echo "=== Test 3: No dependency data ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

# Copy modules but do NOT create dependency-data.json
cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created without dep data"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # Without dep data, fan_in should default to 0, blast_radius = max(0,1) = 1
  FAN_IN=$(jq '.scores[0].fan_in' "$OUTPUT_FILE")
  assert_eq "Fan-in defaults to 0 without dep data" "0" "$FAN_IN"

  BLAST=$(jq '.scores[0].blast_radius' "$OUTPUT_FILE")
  assert_eq "Blast radius defaults to 1 (max of fan_in=0 and 1)" "1" "$BLAST"

  # Verify score is still computed
  SCORE=$(jq '.scores[0].risk_score' "$OUTPUT_FILE")
  assert_gt "Score is positive even without dep data" "$SCORE" "0"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Empty modules directory
# ======================================================================
echo "=== Test 4: Empty modules directory ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Empty input exits with code 0" "0" "$EXIT_CODE"
assert_contains "Prints skip message" "No module JSONs found" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "compute-risk-scores: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
