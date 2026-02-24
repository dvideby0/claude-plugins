#!/usr/bin/env bash
# Tests for git-analysis.sh
# Verifies hotspot counting in a controlled git repo and graceful
# handling of non-git directories.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/git-analysis.sh"

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
# Test 1: Hotspot counting in a controlled git repo
# ======================================================================
echo "=== Test 1: Hotspot counting ==="
TMPDIR=$(mktemp -d)

# Initialize a git repo with known commits
cd "$TMPDIR"
git init -q
git config user.email "test@test.com"
git config user.name "Test User"

# Create files and commit multiple changes to create hotspots
mkdir -p src
echo "v1" > src/hot_file.py
echo "v1" > src/cold_file.py
git add . && git commit -q -m "initial" --date="2025-01-01T00:00:00"

# Modify hot_file multiple times
for i in 2 3 4 5; do
  echo "v$i" > src/hot_file.py
  git add . && git commit -q -m "change $i" --date="2025-12-0${i}T00:00:00"
done

# Return to original directory
cd "$SCRIPT_DIR"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

HOTSPOTS_FILE="$TMPDIR/sdlc-audit/data/git-hotspots.txt"
BUSFACTOR_FILE="$TMPDIR/sdlc-audit/data/git-busfactor.txt"

if [ ! -f "$HOTSPOTS_FILE" ]; then
  echo "  FAIL: Hotspots file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # Verify hotspots file is valid JSON
  jq '.' "$HOTSPOTS_FILE" >/dev/null 2>&1
  assert_eq "Hotspots file is valid JSON" "0" "$?"

  # hot_file.py should have more changes than cold_file.py
  HOT_COUNT=$(jq '[.hotspots[] | select(.file | test("hot_file"))] | .[0].changes // 0' "$HOTSPOTS_FILE")
  COLD_COUNT=$(jq '[.hotspots[] | select(.file | test("cold_file"))] | .[0].changes // 0' "$HOTSPOTS_FILE")

  # hot_file was changed 4 times (commits 2-5), cold_file only once (initial)
  if [ "$HOT_COUNT" -gt "$COLD_COUNT" ] 2>/dev/null; then
    echo "  PASS: hot_file has more changes ($HOT_COUNT) than cold_file ($COLD_COUNT)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: hot_file ($HOT_COUNT) should have more changes than cold_file ($COLD_COUNT)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

if [ ! -f "$BUSFACTOR_FILE" ]; then
  echo "  FAIL: Bus factor file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  BUSFACTOR_CONTENT=$(cat "$BUSFACTOR_FILE")
  assert_contains "Bus factor file has header" "BUS FACTOR" "$BUSFACTOR_CONTENT"
  assert_contains "Bus factor shows commit count" "Total commits" "$BUSFACTOR_CONTENT"
  assert_contains "Bus factor shows Test User" "Test User" "$BUSFACTOR_CONTENT"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Non-git directory exits gracefully
# ======================================================================
echo "=== Test 2: Non-git directory ==="
TMPDIR=$(mktemp -d)

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?

assert_eq "Non-git exits with code 0" "0" "$EXIT_CODE"
assert_contains "Non-git prints skip message" "Not a git repository" "$OUTPUT"

# Verify no output files created
if [ ! -f "$TMPDIR/sdlc-audit/data/git-hotspots.txt" ]; then
  echo "  PASS: No hotspots file for non-git directory"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: Hotspots file should not exist for non-git"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Empty git repo (no commits) handles gracefully
# ======================================================================
echo "=== Test 3: Empty git repo ==="
TMPDIR=$(mktemp -d)

cd "$TMPDIR"
git init -q
cd "$SCRIPT_DIR"

# This should still produce output files (possibly empty hotspots)
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1
EXIT_CODE=$?

assert_eq "Empty git repo exits with code 0" "0" "$EXIT_CODE"

# Output files should be created (even if content is minimal)
if [ -f "$TMPDIR/sdlc-audit/data/git-hotspots.txt" ]; then
  echo "  PASS: Hotspots file created for empty git repo"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: Hotspots file should exist for git repo"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "git-analysis: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
