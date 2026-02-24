#!/usr/bin/env bash
# Edge-case tests for compute-risk-scores.sh
# Regression tests for production bug: "invalid JSON text passed to --argjson"
# when dependency-data.json is malformed or missing fields.

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
# Test 1: Malformed dependency-data.json does not crash scoring
# ======================================================================
echo "=== Test 1: Malformed dependency-data.json ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules" "$TMPDIR/sdlc-audit/data"

cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

# Write invalid JSON to dependency-data.json
echo "{not valid json" > "$TMPDIR/sdlc-audit/data/dependency-data.json"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

assert_eq "Malformed dep data exits with code 0" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  FAN_IN=$(jq '.scores[0].fan_in' "$OUTPUT_FILE")
  assert_eq "Fan-in defaults to 0 with malformed dep data" "0" "$FAN_IN"

  SCORE=$(jq '.scores[0].risk_score' "$OUTPUT_FILE")
  assert_gt "Score is still positive" "$SCORE" "0"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Empty dependency-data.json (zero bytes)
# ======================================================================
echo "=== Test 2: Empty dependency-data.json ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules" "$TMPDIR/sdlc-audit/data"

cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

# Create empty file
touch "$TMPDIR/sdlc-audit/data/dependency-data.json"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

assert_eq "Empty dep data exits with code 0" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  FAN_IN=$(jq '.scores[0].fan_in' "$OUTPUT_FILE")
  assert_eq "Fan-in defaults to 0 with empty dep data" "0" "$FAN_IN"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Module with missing fields uses correct defaults
# ======================================================================
echo "=== Test 3: Missing fields ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_missing_fields.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

assert_eq "Missing fields exits with code 0" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  TOTAL_LINES=$(jq '.scores[0].total_lines' "$OUTPUT_FILE")
  assert_eq "total_lines defaults to 0" "0" "$TOTAL_LINES"

  TEST_COV=$(jq -r '.scores[0].test_coverage' "$OUTPUT_FILE")
  assert_eq "test_coverage defaults to unknown" "unknown" "$TEST_COV"

  # safety_net = tc_score("unknown")=0.5 + dq_score("unknown")=0.5 = 1.0
  SAFETY_NET=$(jq '.scores[0].safety_net' "$OUTPUT_FILE")
  assert_eq "safety_net defaults to 1 (0.5+0.5)" "1" "$SAFETY_NET"

  ISSUE_COUNT=$(jq '.scores[0].issue_count' "$OUTPUT_FILE")
  assert_eq "issue_count = 0 with no files" "0" "$ISSUE_COUNT"

  WEIGHTED=$(jq '.scores[0].weighted_issue_count' "$OUTPUT_FILE")
  assert_eq "weighted_issue_count = 0 with no files" "0" "$WEIGHTED"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Single module percentile edge case
# ======================================================================
echo "=== Test 4: Single module percentile ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

SCORE_COUNT=$(jq '.scores | length' "$OUTPUT_FILE")
assert_eq "Single module scored" "1" "$SCORE_COUNT"

DIST_SUM=$(jq '.risk_distribution | (.critical + .high + .medium + .low)' "$OUTPUT_FILE")
assert_eq "Distribution sums to 1" "1" "$DIST_SUM"

# With n=1, p90=p75=p50 all equal the single score, so score >= p90 is true
CRIT_COUNT=$(jq '.risk_distribution.critical' "$OUTPUT_FILE")
assert_eq "Single module is critical" "1" "$CRIT_COUNT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 5: Definite issues score higher than low-confidence issues
# ======================================================================
echo "=== Test 5: Confidence weighting comparison ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

# Module with 10 definite-confidence issues
cat > "$TMPDIR/sdlc-audit/modules/mod_definite.json" <<'FIXTURE'
{
  "directory": "mod_definite",
  "total_lines": 500,
  "test_coverage": "partial",
  "documentation_quality": "adequate",
  "internal_dependencies": [],
  "external_dependencies": [],
  "files": [
    {
      "path": "mod_definite/main.py",
      "issues": [
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i1"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i2"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i3"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i4"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i5"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i6"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i7"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i8"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i9"},
        {"severity": "warning", "confidence": "definite", "category": "maintainability", "description": "i10"}
      ],
      "functions": []
    }
  ]
}
FIXTURE

# Module with 10 low-confidence issues (same total_lines, same everything else)
cat > "$TMPDIR/sdlc-audit/modules/mod_low.json" <<'FIXTURE'
{
  "directory": "mod_low",
  "total_lines": 500,
  "test_coverage": "partial",
  "documentation_quality": "adequate",
  "internal_dependencies": [],
  "external_dependencies": [],
  "files": [
    {
      "path": "mod_low/main.py",
      "issues": [
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i1"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i2"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i3"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i4"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i5"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i6"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i7"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i8"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i9"},
        {"severity": "warning", "confidence": "low", "category": "maintainability", "description": "i10"}
      ],
      "functions": []
    }
  ]
}
FIXTURE

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  DEFINITE_SCORE=$(jq '[.scores[] | select(.module == "mod_definite")] | .[0].risk_score' "$OUTPUT_FILE")
  LOW_SCORE=$(jq '[.scores[] | select(.module == "mod_low")] | .[0].risk_score' "$OUTPUT_FILE")
  assert_gt "Definite-confidence module scores higher than low-confidence" "$DEFINITE_SCORE" "$LOW_SCORE"

  # Verify weighted_issue_count values
  # mod_definite: 10 issues * 1.0 = 10.0
  DEFINITE_WEIGHTED=$(jq '[.scores[] | select(.module == "mod_definite")] | .[0].weighted_issue_count' "$OUTPUT_FILE")
  assert_eq "mod_definite weighted_issue_count = 10" "10" "$DEFINITE_WEIGHTED"

  # mod_low: 10 issues * 0.2 = 2.0
  LOW_WEIGHTED=$(jq '[.scores[] | select(.module == "mod_low")] | .[0].weighted_issue_count' "$OUTPUT_FILE")
  assert_eq "mod_low weighted_issue_count = 2" "2" "$LOW_WEIGHTED"

  # Both should still have issue_count = 10
  DEFINITE_RAW=$(jq '[.scores[] | select(.module == "mod_definite")] | .[0].issue_count' "$OUTPUT_FILE")
  assert_eq "mod_definite raw issue_count still = 10" "10" "$DEFINITE_RAW"
  LOW_RAW=$(jq '[.scores[] | select(.module == "mod_low")] | .[0].issue_count' "$OUTPUT_FILE")
  assert_eq "mod_low raw issue_count still = 10" "10" "$LOW_RAW"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 6: Missing confidence field defaults to 0.5 weight
# ======================================================================
echo "=== Test 6: Missing confidence defaults to 0.5 ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/sdlc-audit/modules/mod_no_conf.json" <<'FIXTURE'
{
  "directory": "mod_no_conf",
  "total_lines": 100,
  "test_coverage": "full",
  "documentation_quality": "comprehensive",
  "internal_dependencies": [],
  "external_dependencies": [],
  "files": [
    {
      "path": "mod_no_conf/main.py",
      "issues": [
        {"severity": "warning", "category": "maintainability", "description": "no confidence field"},
        {"severity": "warning", "category": "maintainability", "description": "also no confidence"}
      ],
      "functions": []
    }
  ]
}
FIXTURE

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # 2 issues * 0.5 (default) = 1.0
  WEIGHTED=$(jq '.scores[0].weighted_issue_count' "$OUTPUT_FILE")
  assert_eq "Missing confidence defaults to 0.5 (2 issues => 1.0)" "1" "$WEIGHTED"

  # Verify weighted_issue_count is present in output
  HAS_FIELD=$(jq '.scores[0] | has("weighted_issue_count")' "$OUTPUT_FILE")
  assert_eq "weighted_issue_count field exists in output" "true" "$HAS_FIELD"

  # Also verify issue_count is still present
  HAS_RAW=$(jq '.scores[0] | has("issue_count")' "$OUTPUT_FILE")
  assert_eq "issue_count field still exists in output" "true" "$HAS_RAW"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 7: Verify weighted_issue_count appears in output
# ======================================================================
echo "=== Test 7: weighted_issue_count in output ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"

cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
OUTPUT_FILE="$TMPDIR/sdlc-audit/data/risk-scores.json"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # src_api has 3 issues with no confidence => 3 * 0.5 = 1.5
  WEIGHTED=$(jq '.scores[0].weighted_issue_count' "$OUTPUT_FILE")
  assert_eq "src_api weighted_issue_count = 1.5" "1.5" "$WEIGHTED"

  ISSUE_COUNT=$(jq '.scores[0].issue_count' "$OUTPUT_FILE")
  assert_eq "src_api issue_count still = 3" "3" "$ISSUE_COUNT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "compute-risk-scores edge cases: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
