#!/usr/bin/env bash
# Tests for check-prereqs.sh
# Verifies valid JSON output and detection of known tools.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/check-prereqs.sh"

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
# Test 1: Produces valid JSON output
# ======================================================================
echo "=== Test 1: Valid JSON output ==="
TMPDIR=$(mktemp -d)

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/tool-availability.json"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "  FAIL: Output file not created"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  # Verify valid JSON
  jq '.' "$OUTPUT_FILE" >/dev/null 2>&1
  assert_eq "Output is valid JSON" "0" "$?"

  # Verify top-level structure
  HAS_OS=$(jq 'has("os")' "$OUTPUT_FILE")
  assert_eq "Has os field" "true" "$HAS_OS"

  HAS_PKG=$(jq 'has("package_manager")' "$OUTPUT_FILE")
  assert_eq "Has package_manager field" "true" "$HAS_PKG"

  HAS_TOOLS=$(jq 'has("tools")' "$OUTPUT_FILE")
  assert_eq "Has tools field" "true" "$HAS_TOOLS"

  HAS_TIMESTAMP=$(jq 'has("timestamp")' "$OUTPUT_FILE")
  assert_eq "Has timestamp field" "true" "$HAS_TIMESTAMP"

  HAS_LANGS=$(jq 'has("detected_languages")' "$OUTPUT_FILE")
  assert_eq "Has detected_languages field" "true" "$HAS_LANGS"

  HAS_INSTALL=$(jq 'has("install_commands")' "$OUTPUT_FILE")
  assert_eq "Has install_commands field" "true" "$HAS_INSTALL"

  # Verify OS is detected (should not be empty)
  OS_VAL=$(jq -r '.os' "$OUTPUT_FILE")
  if [ -n "$OS_VAL" ] && [ "$OS_VAL" != "null" ]; then
    echo "  PASS: OS detected ($OS_VAL)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: OS not detected"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Detects known available tools
# ======================================================================
echo "=== Test 2: Detects known tools ==="
TMPDIR=$(mktemp -d)

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/tool-availability.json"

# bash is always available (we are running in it)
# jq is required by many tests so it should be available
# At minimum, check that the tools object has entries for core tools
HAS_JQ_ENTRY=$(jq '.tools | has("jq")' "$OUTPUT_FILE")
assert_eq "Tools includes jq entry" "true" "$HAS_JQ_ENTRY"

HAS_RG_ENTRY=$(jq '.tools | has("rg")' "$OUTPUT_FILE")
assert_eq "Tools includes rg entry" "true" "$HAS_RG_ENTRY"

HAS_TREE_ENTRY=$(jq '.tools | has("tree")' "$OUTPUT_FILE")
assert_eq "Tools includes tree entry" "true" "$HAS_TREE_ENTRY"

# If jq is available (which it must be since our other tests use it),
# verify the script correctly reports it
if command -v jq &>/dev/null; then
  JQ_AVAILABLE=$(jq -r '.tools.jq.available' "$OUTPUT_FILE")
  assert_eq "jq detected as available" "true" "$JQ_AVAILABLE"

  JQ_PATH=$(jq -r '.tools.jq.path' "$OUTPUT_FILE")
  EXPECTED_JQ_PATH=$(command -v jq)
  assert_eq "jq path is correct" "$EXPECTED_JQ_PATH" "$JQ_PATH"
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Detects OS correctly on macOS
# ======================================================================
echo "=== Test 3: OS detection ==="
TMPDIR=$(mktemp -d)

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/tool-availability.json"

# On macOS (Darwin), OS should be "macos" and package_manager "brew"
if [[ "$OSTYPE" == darwin* ]]; then
  OS_VAL=$(jq -r '.os' "$OUTPUT_FILE")
  assert_eq "OS is macos on Darwin" "macos" "$OS_VAL"

  PKG_VAL=$(jq -r '.package_manager' "$OUTPUT_FILE")
  assert_eq "Package manager is brew on macOS" "brew" "$PKG_VAL"
else
  # On Linux, just verify OS is one of the expected values
  OS_VAL=$(jq -r '.os' "$OUTPUT_FILE")
  if [ "$OS_VAL" != "null" ] && [ -n "$OS_VAL" ]; then
    echo "  PASS: OS detected on this platform ($OS_VAL)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: OS not detected on this platform"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Language detection with project markers
# ======================================================================
echo "=== Test 4: Language detection ==="
TMPDIR=$(mktemp -d)

# Create Python and Node markers
touch "$TMPDIR/pyproject.toml"
touch "$TMPDIR/package.json"

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" >/dev/null 2>&1

OUTPUT_FILE="$TMPDIR/sdlc-audit/data/tool-availability.json"

PYTHON_DETECTED=$(jq '.detected_languages.python' "$OUTPUT_FILE")
assert_eq "Python detected with pyproject.toml" "true" "$PYTHON_DETECTED"

NODE_DETECTED=$(jq '.detected_languages.node' "$OUTPUT_FILE")
assert_eq "Node detected with package.json" "true" "$NODE_DETECTED"

# Rust should not be detected (no Cargo.toml)
RUST_DETECTED=$(jq '.detected_languages.rust' "$OUTPUT_FILE")
assert_eq "Rust not detected without Cargo.toml" "false" "$RUST_DETECTED"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "check-prereqs: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
