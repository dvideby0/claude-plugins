#!/usr/bin/env bash
# repo-audit: Pre-Analysis Tool Runner
# Runs all deterministic tools (cloc, git, linters, type checkers, dep audits,
# skeleton extractors) with failure logging.
#
# Usage: bash run-pre-analysis-tools.sh [project-root]
# Output: sdlc-audit/tool-output/*, sdlc-audit/data/*
# Failure log: sdlc-audit/data/pre-analysis-failures.log
#
# This script ALWAYS exits 0. Failures are logged but never cascade.

PROJECT_ROOT="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="${PROJECT_ROOT}/sdlc-audit"
DATA_DIR="${AUDIT_DIR}/data"
TOOL_OUTPUT="${AUDIT_DIR}/tool-output"
FAIL_LOG="${DATA_DIR}/pre-analysis-failures.log"
TOOL_AVAIL="${DATA_DIR}/tool-availability.json"
DETECTION="${DATA_DIR}/detection.json"

# --------------------------------------------------------------------------
# Setup
# --------------------------------------------------------------------------
mkdir -p "${DATA_DIR}" "${TOOL_OUTPUT}/linter-results" "${TOOL_OUTPUT}/typecheck" \
         "${TOOL_OUTPUT}/deps" "${DATA_DIR}/skeletons"

{
  echo "# Pre-Analysis Failure Log"
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Project: ${PROJECT_ROOT}"
  echo ""
} > "$FAIL_LOG"

FAIL_COUNT=0
SUCCESS_COUNT=0

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# Run a tool and log failures. Always returns 0.
#   run_tool <name> <output-file> <command...>
run_tool() {
  local name="$1"
  local output_file="$2"
  shift 2

  local stderr_file
  stderr_file=$(mktemp "${TMPDIR:-/tmp}/repo-audit-stderr.XXXXXX")

  # Run the command, capturing stderr separately
  if eval "$@" > "$output_file" 2>"$stderr_file"; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    echo "  [OK]   ${name}"
  else
    local ec=$?
    FAIL_COUNT=$((FAIL_COUNT + 1))
    local stderr_content
    stderr_content=$(cat "$stderr_file" 2>/dev/null | head -20)
    {
      echo "[$(date -u +%H:%M:%S)] ${name} — exited ${ec}"
      if [ -n "$stderr_content" ]; then
        echo "  stderr: ${stderr_content}"
      fi
      echo ""
    } >> "$FAIL_LOG"
    echo "  [FAIL] ${name} (exit ${ec} — logged)"
  fi

  rm -f "$stderr_file"
  return 0
}

# Run a tool where output goes to both stdout and file (piped commands).
# For commands that use 2>&1, stderr is already merged into stdout.
#   run_tool_merged <name> <output-file> <command...>
run_tool_merged() {
  local name="$1"
  local output_file="$2"
  shift 2

  if eval "$@" > "$output_file" 2>&1; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    echo "  [OK]   ${name}"
  else
    local ec=$?
    FAIL_COUNT=$((FAIL_COUNT + 1))
    {
      echo "[$(date -u +%H:%M:%S)] ${name} — exited ${ec}"
      echo "  output: $(head -5 "$output_file" 2>/dev/null)"
      echo ""
    } >> "$FAIL_LOG"
    echo "  [FAIL] ${name} (exit ${ec} — logged)"
  fi

  return 0
}

# Check if a tool is available via tool-availability.json
# Returns 0 if available, 1 if not
tool_available() {
  local tool="$1"
  if [ ! -f "$TOOL_AVAIL" ]; then
    command -v "$tool" &>/dev/null
    return $?
  fi
  # Parse JSON without jq (grep-based)
  if grep -q "\"${tool}\".*\"available\": true" "$TOOL_AVAIL" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Check if a project tool is available (project_tools section)
project_tool_available() {
  local tool="$1"
  if [ ! -f "$TOOL_AVAIL" ]; then
    return 1
  fi
  if grep -A1 "\"${tool}\"" "$TOOL_AVAIL" 2>/dev/null | grep -q '"available": true'; then
    return 0
  fi
  return 1
}

# Check if a language was detected
language_detected() {
  local lang="$1"
  if [ ! -f "$DETECTION" ]; then
    return 1
  fi
  # Check languages array in detection.json
  if grep -q "\"${lang}\"" "$DETECTION" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Check if file exists in project
has_file() {
  [ -f "${PROJECT_ROOT}/$1" ]
}

has_dir() {
  [ -d "${PROJECT_ROOT}/$1" ]
}

echo ""
echo "================================================================"
echo "  Pre-Analysis Tool Runner"
echo "================================================================"
echo ""

# --------------------------------------------------------------------------
# Step 0h: Code Metrics (cloc or tokei)
# --------------------------------------------------------------------------
echo "--- Code Metrics ---"

if tool_available cloc; then
  run_tool "cloc" "${DATA_DIR}/metrics.json" \
    "cloc '${PROJECT_ROOT}' --json --exclude-dir=node_modules,dist,build,.venv,venv,.next,target,obj,vendor,__pycache__,.git,coverage,deps,_build,.dart_tool,Pods,sdlc-audit --by-file"
elif tool_available tokei; then
  run_tool "tokei" "${DATA_DIR}/metrics.json" \
    "tokei '${PROJECT_ROOT}' --output json --exclude node_modules dist build .venv target obj vendor sdlc-audit"
else
  echo "  [SKIP] cloc/tokei — not installed"
fi

# --------------------------------------------------------------------------
# Step 0i: Git History Analysis
# --------------------------------------------------------------------------
echo ""
echo "--- Git History ---"

if has_dir .git; then
  run_tool_merged "git-analysis" "/dev/null" \
    "bash '${SCRIPT_DIR}/git-analysis.sh' '${PROJECT_ROOT}'"
else
  echo "  [SKIP] git-analysis — not a git repository"
fi

# --------------------------------------------------------------------------
# Step 0k: Run Existing Linters
# --------------------------------------------------------------------------
echo ""
echo "--- Linters ---"

# ESLint
if has_file package.json && [ -x "${PROJECT_ROOT}/node_modules/.bin/eslint" ]; then
  run_tool "eslint" "${TOOL_OUTPUT}/linter-results/eslint.json" \
    "cd '${PROJECT_ROOT}' && npx eslint . --format json 2>/dev/null | head -5000"
elif has_file package.json && command -v eslint &>/dev/null; then
  run_tool "eslint" "${TOOL_OUTPUT}/linter-results/eslint.json" \
    "cd '${PROJECT_ROOT}' && eslint . --format json 2>/dev/null | head -5000"
else
  echo "  [SKIP] eslint — not installed or no package.json"
fi

# Ruff
if tool_available ruff && (has_file pyproject.toml || has_file ruff.toml); then
  run_tool "ruff" "${TOOL_OUTPUT}/linter-results/ruff.json" \
    "cd '${PROJECT_ROOT}' && ruff check . --output-format json 2>/dev/null | head -5000"
else
  echo "  [SKIP] ruff — not installed or no Python config"
fi

# Biome
if has_file biome.json && [ -x "${PROJECT_ROOT}/node_modules/.bin/biome" ]; then
  run_tool "biome" "${TOOL_OUTPUT}/linter-results/biome.json" \
    "cd '${PROJECT_ROOT}' && npx biome check . --reporter json 2>/dev/null | head -5000"
else
  echo "  [SKIP] biome — not installed or no biome.json"
fi

# golangci-lint
if tool_available golangci-lint && has_file .golangci.yml; then
  run_tool "golangci-lint" "${TOOL_OUTPUT}/linter-results/golangci.json" \
    "cd '${PROJECT_ROOT}' && golangci-lint run --out-format json 2>/dev/null | head -5000"
else
  echo "  [SKIP] golangci-lint — not installed or no .golangci.yml"
fi

# Rubocop
if tool_available rubocop && has_file .rubocop.yml; then
  run_tool "rubocop" "${TOOL_OUTPUT}/linter-results/rubocop.json" \
    "cd '${PROJECT_ROOT}' && rubocop --format json 2>/dev/null | head -5000"
else
  echo "  [SKIP] rubocop — not installed or no .rubocop.yml"
fi

# --------------------------------------------------------------------------
# Step 0l: Type Checking
# --------------------------------------------------------------------------
echo ""
echo "--- Type Checkers ---"

# TypeScript
if has_file tsconfig.json && ([ -x "${PROJECT_ROOT}/node_modules/.bin/tsc" ] || command -v tsc &>/dev/null); then
  # tsc exits non-zero when type errors are found — that's expected
  run_tool_merged "tsc" "${TOOL_OUTPUT}/typecheck/tsc.txt" \
    "cd '${PROJECT_ROOT}' && npx tsc --noEmit --pretty false 2>&1 | head -500"
  # Always append exit code regardless of success/failure
  echo "EXIT_CODE=$?" >> "${TOOL_OUTPUT}/typecheck/tsc.txt"
else
  echo "  [SKIP] tsc — not installed or no tsconfig.json"
fi

# Go vet
if has_file go.mod && command -v go &>/dev/null; then
  run_tool_merged "go-vet" "${TOOL_OUTPUT}/typecheck/govet.txt" \
    "cd '${PROJECT_ROOT}' && go vet ./... 2>&1 | head -200"
else
  echo "  [SKIP] go-vet — not installed or no go.mod"
fi

# Cargo check
if has_file Cargo.toml && command -v cargo &>/dev/null; then
  run_tool_merged "cargo-check" "${TOOL_OUTPUT}/typecheck/cargo-check.txt" \
    "cd '${PROJECT_ROOT}' && cargo check --message-format short 2>&1 | head -200"
else
  echo "  [SKIP] cargo-check — not installed or no Cargo.toml"
fi

# --------------------------------------------------------------------------
# Step 0m: Dependency Vulnerability Audit
# --------------------------------------------------------------------------
echo ""
echo "--- Dependency Audits ---"

# npm audit
if has_file package-lock.json && command -v npm &>/dev/null; then
  run_tool "npm-audit" "${TOOL_OUTPUT}/deps/npm-audit.json" \
    "cd '${PROJECT_ROOT}' && npm audit --json"
elif has_file package-lock.json; then
  echo "  [SKIP] npm-audit — npm not available"
else
  echo "  [SKIP] npm-audit — no package-lock.json"
fi

# yarn audit
if has_file yarn.lock && command -v yarn &>/dev/null; then
  run_tool "yarn-audit" "${TOOL_OUTPUT}/deps/yarn-audit.json" \
    "cd '${PROJECT_ROOT}' && yarn audit --json"
else
  echo "  [SKIP] yarn-audit — no yarn.lock or yarn not available"
fi

# pnpm audit
if has_file pnpm-lock.yaml && command -v pnpm &>/dev/null; then
  run_tool "pnpm-audit" "${TOOL_OUTPUT}/deps/pnpm-audit.json" \
    "cd '${PROJECT_ROOT}' && pnpm audit --json"
else
  echo "  [SKIP] pnpm-audit — no pnpm-lock.yaml or pnpm not available"
fi

# pip-audit
if (has_file requirements.txt || has_file pyproject.toml) && command -v pip-audit &>/dev/null; then
  run_tool "pip-audit" "${TOOL_OUTPUT}/deps/pip-audit.json" \
    "cd '${PROJECT_ROOT}' && pip-audit --format json"
else
  echo "  [SKIP] pip-audit — no Python manifests or pip-audit not available"
fi

# cargo-audit
if has_file Cargo.lock && command -v cargo-audit &>/dev/null; then
  run_tool "cargo-audit" "${TOOL_OUTPUT}/deps/cargo-audit.json" \
    "cd '${PROJECT_ROOT}' && cargo audit --json"
else
  echo "  [SKIP] cargo-audit — no Cargo.lock or cargo-audit not available"
fi

# govulncheck
if has_file go.sum && command -v govulncheck &>/dev/null; then
  run_tool "govulncheck" "${TOOL_OUTPUT}/deps/govulncheck.txt" \
    "cd '${PROJECT_ROOT}' && govulncheck ./..."
else
  echo "  [SKIP] govulncheck — no go.sum or govulncheck not available"
fi

# bundle-audit
if has_file Gemfile.lock && command -v bundle-audit &>/dev/null; then
  run_tool "bundle-audit" "${TOOL_OUTPUT}/deps/bundle-audit.txt" \
    "cd '${PROJECT_ROOT}' && bundle-audit check"
else
  echo "  [SKIP] bundle-audit — no Gemfile.lock or bundle-audit not available"
fi

# composer audit
if has_file composer.lock && command -v composer &>/dev/null; then
  run_tool "composer-audit" "${TOOL_OUTPUT}/deps/composer-audit.json" \
    "cd '${PROJECT_ROOT}' && composer audit --format json"
else
  echo "  [SKIP] composer-audit — no composer.lock or composer not available"
fi

# --------------------------------------------------------------------------
# Step 0n: Code Skeletons (bash-based only)
# --------------------------------------------------------------------------
echo ""
echo "--- Code Skeletons ---"

# Python skeleton extraction
if tool_available python3; then
  # Check if there are any .py files
  if find "${PROJECT_ROOT}" -name '*.py' -not -path '*/node_modules/*' -not -path '*/.venv/*' \
     -not -path '*/venv/*' -not -path '*/sdlc-audit/*' -print -quit 2>/dev/null | grep -q .; then
    run_tool_merged "python-skeletons" "/dev/null" \
      "python3 '${SCRIPT_DIR}/extract-skeletons.py' '${PROJECT_ROOT}'"
  else
    echo "  [SKIP] python-skeletons — no .py files found"
  fi
else
  echo "  [SKIP] python-skeletons — python3 not available"
fi

# Go doc extraction
if has_file go.mod && command -v go &>/dev/null; then
  run_tool "go-doc" "${DATA_DIR}/skeletons/go-api.txt" \
    "cd '${PROJECT_ROOT}' && go doc -all ./... 2>/dev/null | head -2000"
else
  echo "  [SKIP] go-doc — not installed or no go.mod"
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "================================================================"
echo "  Pre-Analysis Complete"
echo "  Succeeded: ${SUCCESS_COUNT}  |  Failed: ${FAIL_COUNT}  |  Log: sdlc-audit/data/pre-analysis-failures.log"
echo "================================================================"
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "# No failures recorded." >> "$FAIL_LOG"
fi

# Always exit 0 — failures are logged, not propagated
exit 0
