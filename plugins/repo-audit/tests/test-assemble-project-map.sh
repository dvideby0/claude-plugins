#!/usr/bin/env bash
# Tests for assemble-project-map.sh
# Verifies PROJECT_MAP.md generation from detection.json, metrics, and modules.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/assemble-project-map.sh"
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
# Test 1: Happy path with detection.json and modules
# ======================================================================
echo "=== Test 1: Happy path ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data" "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/sdlc-audit/data/detection.json" <<'EOF'
{
  "primary_languages": ["Python"],
  "secondary_languages": ["JavaScript"],
  "frameworks": {"web": ["Flask", "Express"]},
  "all_directories": {
    "src_api": {"category": "source", "languages": ["Python"], "est_files": 10},
    "src_auth": {"category": "source", "languages": ["Python"], "est_files": 5}
  },
  "tooling": {"linter": "ruff", "formatter": "black"}
}
EOF

cp "$FIXTURES_DIR/src_api.json" "$TMPDIR/sdlc-audit/modules/"
cp "$FIXTURES_DIR/src_auth.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/PROJECT_MAP.md"

assert_eq "Exit code is 0" "0" "$EXIT_CODE"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: PROJECT_MAP.md not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Has title" "# Project Map" "$CONTENT"
  assert_contains "Lists primary language" "Python" "$CONTENT"
  assert_contains "Lists framework" "Flask" "$CONTENT"
  assert_contains "Has directory structure" "Directory Structure" "$CONTENT"
  assert_contains "Has module purposes" "Module Purposes" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Missing detection.json exits 0
# ======================================================================
echo "=== Test 2: Missing detection.json ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Missing detection exits with code 0" "0" "$EXIT_CODE"
assert_contains "Prints skip message" "detection.json not found" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: With metrics.json shows code metrics
# ======================================================================
echo "=== Test 3: Code metrics section ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data" "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/sdlc-audit/data/detection.json" <<'EOF'
{
  "primary_languages": ["Python"],
  "all_directories": {
    "src": {"category": "source", "languages": ["Python"], "est_files": 15}
  }
}
EOF

cat > "$TMPDIR/sdlc-audit/data/metrics.json" <<'EOF'
{
  "Python": {"nFiles": 15, "code": 2000, "comment": 200, "blank": 100},
  "SUM": {"nFiles": 15, "code": 2000, "comment": 200, "blank": 100}
}
EOF

cp "$FIXTURES_DIR/src_utils.json" "$TMPDIR/sdlc-audit/modules/"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/reports/PROJECT_MAP.md"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Report not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  CONTENT=$(cat "$OUTPUT_FILE")
  assert_contains "Has code metrics section" "Code Metrics" "$CONTENT"
  assert_contains "Shows line count" "2000" "$CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "assemble-project-map: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
