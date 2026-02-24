#!/usr/bin/env bash
# Tests for merge-module-findings.sh
# Verifies merging sub-command findings into standard module JSONs.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="${REPO_ROOT}/scripts/merge-module-findings.sh"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"

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
# Test 1: Merge findings into new modules (no existing JSONs)
# ======================================================================
echo "=== Test 1: Merge into new modules ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"
mkdir -p "$TMPDIR/sdlc-audit/modules"

# Create a minimal detection.json with directory mappings
cat > "$TMPDIR/sdlc-audit/data/detection.json" << 'DETECTION'
{
  "primary_languages": ["python"],
  "all_directories": {
    "src/auth": {
      "category": "source",
      "est_files": 5,
      "languages": ["python"]
    },
    "src/utils": {
      "category": "source",
      "est_files": 3,
      "languages": ["python"]
    },
    "src/api": {
      "category": "source",
      "est_files": 4,
      "languages": ["python"]
    }
  }
}
DETECTION

# Run the merge with security findings
OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" 2>&1)
EXIT_CODE=$?

assert_eq "Exit code is 0" "0" "$EXIT_CODE"

# Check that module files were created
assert_eq "src_auth module created" "true" "$([ -f "$TMPDIR/sdlc-audit/modules/src_auth.json" ] && echo true || echo false)"
assert_eq "src_utils module created" "true" "$([ -f "$TMPDIR/sdlc-audit/modules/src_utils.json" ] && echo true || echo false)"
assert_eq "src_api module created" "true" "$([ -f "$TMPDIR/sdlc-audit/modules/src_api.json" ] && echo true || echo false)"

# Check src_auth module has correct structure
AUTH_DIR=$(jq -r '.directory' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "src_auth directory field" "src/auth" "$AUTH_DIR"

AUTH_FILES=$(jq '.files | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "src_auth has 2 files" "2" "$AUTH_FILES"

AUTH_SOURCES=$(jq -r '.sources | join(",")' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "src_auth sources contains audit-security" "audit-security" "$AUTH_SOURCES"

# Check that issues were placed in correct files
CONFIG_ISSUES=$(jq '[.files[] | select(.path == "src/auth/config.py") | .issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "config.py has 1 issue" "1" "$CONFIG_ISSUES"

LOGIN_ISSUES=$(jq '[.files[] | select(.path == "src/auth/login.py") | .issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "login.py has 1 issue" "1" "$LOGIN_ISSUES"

# Check severity was preserved
CONFIG_SEV=$(jq -r '[.files[] | select(.path == "src/auth/config.py") | .issues[0].severity] | .[0]' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "config.py issue severity is critical" "critical" "$CONFIG_SEV"

# Check test_coverage defaults to unknown for new modules
TC=$(jq -r '.test_coverage' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "New module test_coverage is unknown" "unknown" "$TC"

# Check category from detection.json
CAT=$(jq -r '.category' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "Category pulled from detection.json" "source" "$CAT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 2: Merge findings into existing module
# ======================================================================
echo "=== Test 2: Merge into existing module ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"
mkdir -p "$TMPDIR/sdlc-audit/modules"

# Create detection.json
cat > "$TMPDIR/sdlc-audit/data/detection.json" << 'DETECTION'
{
  "all_directories": {
    "src/auth": { "category": "source", "languages": ["python"] },
    "src/utils": { "category": "source", "languages": ["python"] },
    "src/api": { "category": "source", "languages": ["python"] }
  }
}
DETECTION

# Create an existing module JSON for src_auth
cat > "$TMPDIR/sdlc-audit/modules/src_auth.json" << 'MODULE'
{
  "directory": "src/auth",
  "directories_analyzed": ["src/auth"],
  "category": "source",
  "languages_found": ["python"],
  "purpose": "Authentication and authorization module",
  "file_count": 3,
  "total_lines": 500,
  "files": [
    {
      "path": "src/auth/login.py",
      "language": "python",
      "lines": 200,
      "issues": [
        {
          "severity": "warning",
          "confidence": "high",
          "category": "maintainability",
          "source": "llm-analysis",
          "description": "Function too complex — consider refactoring",
          "line_range": [10, 80]
        }
      ]
    },
    {
      "path": "src/auth/session.py",
      "language": "python",
      "lines": 150,
      "issues": []
    }
  ],
  "internal_dependencies": ["src/utils"],
  "external_dependencies": ["bcrypt"],
  "test_coverage": "partial",
  "documentation_quality": "sparse"
}
MODULE

# Run merge with security findings (which adds to login.py and creates config.py)
OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" 2>&1)
EXIT_CODE=$?

assert_eq "Exit code is 0" "0" "$EXIT_CODE"

# Existing issues should be preserved
EXISTING_ISSUE=$(jq '[.files[] | select(.path == "src/auth/login.py") | .issues[] | select(.description == "Function too complex — consider refactoring")] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "Existing issue preserved in login.py" "1" "$EXISTING_ISSUE"

# New issue should be added
NEW_ISSUE=$(jq '[.files[] | select(.path == "src/auth/login.py") | .issues[] | select(.description == "SQL injection via string concatenation in login query")] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "New security issue added to login.py" "1" "$NEW_ISSUE"

# New file entry should be created for config.py
CONFIG_EXISTS=$(jq '[.files[] | select(.path == "src/auth/config.py")] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "New file config.py added to module" "1" "$CONFIG_EXISTS"

# Sources field should be added
SOURCES=$(jq -r '.sources | join(",")' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "Sources includes audit-security" "audit-security" "$SOURCES"

# Existing fields should be preserved
PURPOSE=$(jq -r '.purpose' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "Purpose preserved" "Authentication and authorization module" "$PURPOSE"

TC=$(jq -r '.test_coverage' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "test_coverage preserved" "partial" "$TC"

DEPS=$(jq -r '.internal_dependencies | join(",")' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "internal_dependencies preserved" "src/utils" "$DEPS"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 3: Deduplication — same finding twice doesn't create duplicates
# ======================================================================
echo "=== Test 3: Deduplication ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"
mkdir -p "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/sdlc-audit/data/detection.json" << 'DETECTION'
{
  "all_directories": {
    "src/auth": { "category": "source", "languages": ["python"] },
    "src/utils": { "category": "source", "languages": ["python"] },
    "src/api": { "category": "source", "languages": ["python"] }
  }
}
DETECTION

# First merge
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" >/dev/null 2>&1

# Count issues in src_auth after first merge
FIRST_COUNT=$(jq '[.files[].issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")

# Second merge with same findings
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" >/dev/null 2>&1

# Count issues after second merge — should be the same
SECOND_COUNT=$(jq '[.files[].issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")

assert_eq "Issue count unchanged after re-merge" "$FIRST_COUNT" "$SECOND_COUNT"

# Verify specific: login.py should still have exactly 1 issue
LOGIN_ISSUES=$(jq '[.files[] | select(.path == "src/auth/login.py") | .issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "login.py still has 1 issue (no dups)" "1" "$LOGIN_ISSUES"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 4: Sources tracking — no duplicates on re-merge
# ======================================================================
echo "=== Test 4: Sources tracking ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"
mkdir -p "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/sdlc-audit/data/detection.json" << 'DETECTION'
{
  "all_directories": {
    "src/auth": { "category": "source", "languages": ["python"] },
    "src/utils": { "category": "source", "languages": ["python"] },
    "src/api": { "category": "source", "languages": ["python"] }
  }
}
DETECTION

# First merge with security
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" >/dev/null 2>&1

SOURCES_1=$(jq -r '.sources | join(",")' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "Sources after first merge" "audit-security" "$SOURCES_1"

# Second merge with same source — should not duplicate
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" >/dev/null 2>&1

SOURCES_2=$(jq '.sources | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "Sources count unchanged after re-merge" "1" "$SOURCES_2"

# Third merge with a different source
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_arch.json" "audit-arch" >/dev/null 2>&1

SOURCES_3=$(jq '.sources | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "Sources count is 2 after different source" "2" "$SOURCES_3"

SOURCES_LIST=$(jq -r '.sources | sort | join(",")' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "Sources contains both commands" "audit-arch,audit-security" "$SOURCES_LIST"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 5: Multiple files mapped to different modules
# ======================================================================
echo "=== Test 5: Multi-module mapping ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"
mkdir -p "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/sdlc-audit/data/detection.json" << 'DETECTION'
{
  "all_directories": {
    "src/auth": { "category": "source", "languages": ["python"] },
    "src/utils": { "category": "source", "languages": ["python"] },
    "src/api": { "category": "source", "languages": ["python"] }
  }
}
DETECTION

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" >/dev/null 2>&1

# Findings should be distributed across 3 modules
assert_eq "src_auth module exists" "true" "$([ -f "$TMPDIR/sdlc-audit/modules/src_auth.json" ] && echo true || echo false)"
assert_eq "src_utils module exists" "true" "$([ -f "$TMPDIR/sdlc-audit/modules/src_utils.json" ] && echo true || echo false)"
assert_eq "src_api module exists" "true" "$([ -f "$TMPDIR/sdlc-audit/modules/src_api.json" ] && echo true || echo false)"

# src/auth has 2 findings (config.py + login.py)
AUTH_FINDINGS=$(jq '[.files[].issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_auth.json")
assert_eq "src_auth has 2 findings total" "2" "$AUTH_FINDINGS"

# src/utils has 1 finding
UTILS_FINDINGS=$(jq '[.files[].issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_utils.json")
assert_eq "src_utils has 1 finding" "1" "$UTILS_FINDINGS"

# src/api has 1 finding
API_FINDINGS=$(jq '[.files[].issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_api.json")
assert_eq "src_api has 1 finding" "1" "$API_FINDINGS"

# Each module should have audit-security as source
for mod in src_auth src_utils src_api; do
  SRC=$(jq -r '.sources[0]' "$TMPDIR/sdlc-audit/modules/${mod}.json")
  assert_eq "${mod} has audit-security source" "audit-security" "$SRC"
done

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 6: Empty findings array
# ======================================================================
echo "=== Test 6: Empty findings ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"
mkdir -p "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/empty_findings.json" << 'EOF'
{
  "findings": []
}
EOF

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$TMPDIR/empty_findings.json" "audit-security" 2>&1)
EXIT_CODE=$?

assert_eq "Empty findings exits 0" "0" "$EXIT_CODE"
assert_contains "Reports no findings" "No findings" "$OUTPUT"

# No module files should be created
MODULE_COUNT=$(ls "$TMPDIR/sdlc-audit/modules/"*.json 2>/dev/null | wc -l | tr -d ' ')
assert_eq "No module files created for empty findings" "0" "$MODULE_COUNT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 7: Missing arguments
# ======================================================================
echo "=== Test 7: Missing arguments ==="
TMPDIR=$(mktemp -d)

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" 2>&1)
EXIT_CODE=$?
assert_eq "Missing findings-file exits 1" "1" "$EXIT_CODE"
assert_contains "Error message for missing findings file" "findings file path is required" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "/nonexistent/file.json" 2>&1)
EXIT_CODE=$?
assert_eq "Missing source-command exits 1" "1" "$EXIT_CODE"
assert_contains "Error message for missing source-command" "source-command is required" "$OUTPUT"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 8: No detection.json — module derived from path
# ======================================================================
echo "=== Test 8: No detection.json — path-derived modules ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/modules"
# Deliberately NOT creating detection.json

bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" >/dev/null 2>&1
EXIT_CODE=$?

assert_eq "Exit code is 0 without detection.json" "0" "$EXIT_CODE"

# Modules should still be created with path-derived names
# src/auth/config.py and src/auth/login.py -> src/auth -> src_auth.json
assert_eq "src_auth module created from path" "true" "$([ -f "$TMPDIR/sdlc-audit/modules/src_auth.json" ] && echo true || echo false)"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Test 9: Dedup with null line_range
# ======================================================================
echo "=== Test 9: Dedup with null line_range ==="
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/sdlc-audit/data"
mkdir -p "$TMPDIR/sdlc-audit/modules"

cat > "$TMPDIR/sdlc-audit/data/detection.json" << 'DETECTION'
{
  "all_directories": {
    "src/api": { "category": "source", "languages": ["python"] }
  }
}
DETECTION

# findings_security.json has a finding for src/api/routes.py with null line_range
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" >/dev/null 2>&1

API_ISSUES_1=$(jq '[.files[] | select(.path == "src/api/routes.py") | .issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_api.json")

# Re-merge — null line_range findings should be deduped
bash "$SCRIPT_UNDER_TEST" "$TMPDIR" "$FIXTURES_DIR/findings_security.json" "audit-security" >/dev/null 2>&1

API_ISSUES_2=$(jq '[.files[] | select(.path == "src/api/routes.py") | .issues[]] | length' "$TMPDIR/sdlc-audit/modules/src_api.json")
assert_eq "Null line_range dedup works" "$API_ISSUES_1" "$API_ISSUES_2"

rm -rf "$TMPDIR"
TMPDIR=""

# ======================================================================
# Summary
# ======================================================================
echo ""
echo "merge-module-findings: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

[ "$FAIL_COUNT" -eq 0 ] || exit 1
