#!/usr/bin/env bash
# repo-audit prerequisite checker
# Detects OS, checks for available tools, and outputs install instructions.
# This script is read-only — it never installs anything.
#
# Usage: bash check-prereqs.sh [project-root]
# Output: writes sdlc-audit/data/tool-availability.json and prints a summary

set -o pipefail

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${PROJECT_ROOT}/sdlc-audit/data"
OUTPUT_FILE="${OUTPUT_DIR}/tool-availability.json"

# --------------------------------------------------------------------------
# OS / package manager detection
# --------------------------------------------------------------------------
detect_os() {
  if [[ "$OSTYPE" == darwin* ]]; then
    echo "macos"
  elif [ -f /etc/os-release ]; then
    . /etc/os-release
    case "$ID" in
      ubuntu|debian|pop|linuxmint|elementary) echo "debian" ;;
      fedora)                                 echo "fedora" ;;
      rhel|centos|rocky|alma|ol)              echo "rhel"   ;;
      arch|manjaro|endeavouros)               echo "arch"   ;;
      alpine)                                 echo "alpine" ;;
      *)                                      echo "linux"  ;;
    esac
  elif command -v apt-get &>/dev/null; then
    echo "debian"
  elif command -v dnf &>/dev/null; then
    echo "fedora"
  elif command -v pacman &>/dev/null; then
    echo "arch"
  elif command -v apk &>/dev/null; then
    echo "alpine"
  else
    echo "unknown"
  fi
}

detect_pkg_manager() {
  case "$1" in
    macos)  echo "brew"   ;;
    debian) echo "apt"    ;;
    fedora) echo "dnf"    ;;
    rhel)   echo "yum"    ;;
    arch)   echo "pacman" ;;
    alpine) echo "apk"    ;;
    *)      echo "unknown" ;;
  esac
}

OS=$(detect_os)
PKG=$(detect_pkg_manager "$OS")

# --------------------------------------------------------------------------
# Tool check helpers
# --------------------------------------------------------------------------
tool_version() {
  # Try common version flags; return empty on failure
  local cmd="$1"
  "$cmd" --version 2>/dev/null | head -1 || "$cmd" -v 2>/dev/null | head -1 || echo ""
}

tool_path() {
  command -v "$1" 2>/dev/null || echo ""
}

check_tool() {
  local name="$1"
  local path
  path=$(tool_path "$name")
  if [ -n "$path" ]; then
    echo "available"
  else
    echo "missing"
  fi
}

# Check for a tool inside node_modules/.bin (project-local)
check_npx_tool() {
  local name="$1"
  if [ -x "${PROJECT_ROOT}/node_modules/.bin/${name}" ]; then
    echo "available"
  elif command -v "$name" &>/dev/null; then
    echo "available"
  else
    echo "missing"
  fi
}

# --------------------------------------------------------------------------
# Install command lookup
# --------------------------------------------------------------------------
install_cmd() {
  local tool="$1"
  case "$tool" in
    jq)
      case "$PKG" in
        brew)    echo "brew install jq" ;;
        apt)     echo "sudo apt install -y jq" ;;
        dnf)     echo "sudo dnf install -y jq" ;;
        yum)     echo "sudo yum install -y jq" ;;
        pacman)  echo "sudo pacman -S --noconfirm jq" ;;
        apk)     echo "sudo apk add jq" ;;
        *)       echo "# Install jq: https://jqlang.github.io/jq/download/" ;;
      esac ;;
    rg)
      case "$PKG" in
        brew)    echo "brew install ripgrep" ;;
        apt)     echo "sudo apt install -y ripgrep" ;;
        dnf)     echo "sudo dnf install -y ripgrep" ;;
        yum)     echo "sudo yum install -y ripgrep" ;;
        pacman)  echo "sudo pacman -S --noconfirm ripgrep" ;;
        apk)     echo "sudo apk add ripgrep" ;;
        *)       echo "cargo install ripgrep" ;;
      esac ;;
    tree)
      case "$PKG" in
        brew)    echo "brew install tree" ;;
        apt)     echo "sudo apt install -y tree" ;;
        dnf)     echo "sudo dnf install -y tree" ;;
        yum)     echo "sudo yum install -y tree" ;;
        pacman)  echo "sudo pacman -S --noconfirm tree" ;;
        apk)     echo "sudo apk add tree" ;;
        *)       echo "# Install tree for your platform" ;;
      esac ;;
    cloc)
      case "$PKG" in
        brew)    echo "brew install cloc" ;;
        apt)     echo "sudo apt install -y cloc" ;;
        dnf)     echo "sudo dnf install -y cloc" ;;
        yum)     echo "sudo yum install -y cloc" ;;
        pacman)  echo "sudo pacman -S --noconfirm cloc" ;;
        apk)     echo "sudo apk add cloc" ;;
        *)       echo "npm install -g cloc" ;;
      esac ;;
    tokei)
      case "$PKG" in
        brew)    echo "brew install tokei" ;;
        pacman)  echo "sudo pacman -S --noconfirm tokei" ;;
        *)       echo "cargo install tokei" ;;
      esac ;;
    pip-audit)   echo "pip install pip-audit" ;;
    cargo-audit) echo "cargo install cargo-audit" ;;
    govulncheck) echo "go install golang.org/x/vuln/cmd/govulncheck@latest" ;;
    bundle-audit) echo "gem install bundler-audit" ;;
  esac
}

# --------------------------------------------------------------------------
# Tool descriptions (why install it)
# --------------------------------------------------------------------------
tool_description() {
  case "$1" in
    jq)           echo "JSON processing — builds dependency graphs, computes risk scores, extracts variant patterns (most impactful tool)" ;;
    rg)           echo "Fast pattern scanning — pre-detects security issues, anti-patterns, and code smells across your entire repo" ;;
    tree)         echo "Directory visualization — generates visual directory structure during discovery phase" ;;
    cloc)         echo "Code metrics — instant, accurate line counts by language (code vs comments vs blanks)" ;;
    tokei)        echo "Code metrics — alternative to cloc, same purpose (only one needed)" ;;
    python3)      echo "Python AST extraction — extracts code skeletons from Python files (only needed for Python projects)" ;;
    pip-audit)    echo "Python dependency audit — scans for known security vulnerabilities (CVEs) in Python packages" ;;
    cargo-audit)  echo "Rust dependency audit — scans for known security vulnerabilities in Rust crates" ;;
    govulncheck)  echo "Go dependency audit — scans for known security vulnerabilities in Go modules" ;;
    bundle-audit) echo "Ruby dependency audit — scans for known security vulnerabilities in Ruby gems" ;;
  esac
}

# --------------------------------------------------------------------------
# Detect project languages (to decide which Tier 3 tools to check)
# --------------------------------------------------------------------------
has_python=false
has_rust=false
has_go=false
has_ruby=false
has_node=false

[ -f "${PROJECT_ROOT}/requirements.txt" ] || [ -f "${PROJECT_ROOT}/pyproject.toml" ] || \
  [ -f "${PROJECT_ROOT}/setup.py" ] || [ -f "${PROJECT_ROOT}/Pipfile" ] && has_python=true

[ -f "${PROJECT_ROOT}/Cargo.toml" ] && has_rust=true
[ -f "${PROJECT_ROOT}/go.mod" ] && has_go=true
[ -f "${PROJECT_ROOT}/Gemfile" ] && has_ruby=true
[ -f "${PROJECT_ROOT}/package.json" ] && has_node=true

# --------------------------------------------------------------------------
# Check all tools
# --------------------------------------------------------------------------
declare -A STATUS
declare -A TIER

# jq is REQUIRED — check it first
STATUS[jq]=$(check_tool "jq")
TIER[jq]=0

# Tier 1 — Core enhancements (optional)
for t in rg tree; do
  STATUS[$t]=$(check_tool "$t")
  TIER[$t]=1
done

# Tier 2 — Code metrics (only need one of cloc/tokei)
for t in cloc tokei; do
  STATUS[$t]=$(check_tool "$t")
  TIER[$t]=2
done

# Tier 3 — Language-specific (only if that language is detected)
if $has_python; then
  # python3 is only needed for AST skeleton extraction on Python projects
  STATUS[python3]=$(check_tool python3)
  TIER[python3]=3
  STATUS[pip-audit]=$(check_tool pip-audit)
  TIER[pip-audit]=3
fi
if $has_rust; then
  STATUS[cargo-audit]=$(check_tool cargo-audit)
  TIER[cargo-audit]=3
fi
if $has_go; then
  STATUS[govulncheck]=$(check_tool govulncheck)
  TIER[govulncheck]=3
fi
if $has_ruby; then
  STATUS[bundle-audit]=$(check_tool bundle-audit)
  TIER[bundle-audit]=3
fi

# Project-local tools (not installable globally — come with the project)
declare -A PROJECT_TOOLS
if $has_node; then
  PROJECT_TOOLS[tsc]=$(check_npx_tool tsc)
  PROJECT_TOOLS[eslint]=$(check_npx_tool eslint)
  PROJECT_TOOLS[biome]=$(check_npx_tool biome)
fi
if $has_python; then
  PROJECT_TOOLS[ruff]=$(check_tool ruff)
  PROJECT_TOOLS[mypy]=$(check_tool mypy)
fi
if $has_go; then
  PROJECT_TOOLS[go_vet]=$(check_tool go)  # go vet is part of go
fi
if $has_rust; then
  PROJECT_TOOLS[cargo_clippy]=$(check_tool cargo)  # clippy is part of cargo
fi

# --------------------------------------------------------------------------
# Collect missing tools and build install commands
# --------------------------------------------------------------------------
MISSING=()
MISSING_CMDS=()

for t in jq rg tree cloc tokei python3 pip-audit cargo-audit govulncheck bundle-audit; do
  if [ "${STATUS[$t]}" = "missing" ] 2>/dev/null; then
    # Skip tokei if cloc is available (only need one)
    if [ "$t" = "tokei" ] && [ "${STATUS[cloc]}" = "available" ]; then
      continue
    fi
    # Skip cloc if tokei is available
    if [ "$t" = "cloc" ] && [ "${STATUS[tokei]}" = "available" ]; then
      continue
    fi
    MISSING+=("$t")
    MISSING_CMDS+=("$(install_cmd "$t")")
  fi
done

# --------------------------------------------------------------------------
# Print human-readable summary
# --------------------------------------------------------------------------
echo ""
echo "================================================================"
echo "  repo-audit prerequisite check"
echo "================================================================"
echo "  OS: ${OS} (${PKG})"
echo "----------------------------------------------------------------"
echo ""

# Print available tools
printf "  Available:  "
first=true
for t in jq rg tree cloc tokei; do
  if [ "${STATUS[$t]}" = "available" ] 2>/dev/null; then
    $first || printf ", "
    printf "%s" "$t"
    first=false
  fi
done
# Project tools
for t in "${!PROJECT_TOOLS[@]}"; do
  if [ "${PROJECT_TOOLS[$t]}" = "available" ]; then
    $first || printf ", "
    printf "%s" "$t"
    first=false
  fi
done
echo ""

# Print missing tools
if [ ${#MISSING[@]} -gt 0 ]; then
  printf "  Missing:    "
  first=true
  for t in "${MISSING[@]}"; do
    $first || printf ", "
    printf "%s" "$t"
    first=false
  done
  echo ""
  echo ""
  echo "----------------------------------------------------------------"
  echo "  MISSING TOOLS"
  echo "----------------------------------------------------------------"
  for t in "${MISSING[@]}"; do
    echo ""
    desc=$(tool_description "$t")
    echo "  $t — $desc"
    echo ""
    echo "    $(install_cmd "$t")"
  done

  echo ""
  echo "----------------------------------------------------------------"
  echo "  Install all missing (copy & paste):"
  echo ""
  printf "    "
  first=true
  for cmd in "${MISSING_CMDS[@]}"; do
    $first || printf " && "
    printf "%s" "$cmd"
    first=false
  done
  echo ""
else
  echo ""
  echo "  All tools available!"
fi

# --- jq hard requirement check ---
if [ "${STATUS[jq]}" = "missing" ]; then
  echo ""
  echo "================================================================"
  echo "  ERROR: jq is REQUIRED but not installed."
  echo ""
  echo "  jq — $(tool_description jq)"
  echo ""
  echo "  Install it with:"
  echo "    $(install_cmd jq)"
  echo ""
  echo "  Then re-run the audit."
  echo "================================================================"
  echo ""
  # Still write the JSON output before exiting
else
  echo ""
  echo "----------------------------------------------------------------"
  if [ ${#MISSING_CMDS[@]} -gt 0 ]; then
    echo "  jq (required) is available. Optional tools make the audit"
    echo "  faster and more thorough. Missing tools = some checks skipped."
  else
    echo "  jq (required) is available. All optional tools also present."
  fi
  echo "================================================================"
  echo ""
fi

# --------------------------------------------------------------------------
# Write machine-readable JSON
# --------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"

# Build JSON manually to avoid jq dependency
{
  echo "{"
  echo "  \"os\": \"${OS}\","
  echo "  \"package_manager\": \"${PKG}\","
  echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"tools\": {"

  tool_json_entries=()
  for t in jq rg tree cloc tokei; do
    s="${STATUS[$t]:-missing}"
    avail="false"
    [ "$s" = "available" ] && avail="true"
    p=$(tool_path "$t")
    tool_json_entries+=("    \"${t}\": {\"available\": ${avail}, \"path\": \"${p}\"}")
  done
  # Tier 3 tools (includes python3 when Python project detected)
  for t in python3 pip-audit cargo-audit govulncheck bundle-audit; do
    if [ -n "${STATUS[$t]+x}" ]; then
      s="${STATUS[$t]}"
      avail="false"
      [ "$s" = "available" ] && avail="true"
      p=$(tool_path "$t")
      tool_json_entries+=("    \"${t//-/_}\": {\"available\": ${avail}, \"path\": \"${p}\"}")
    fi
  done

  # Join with commas
  total=${#tool_json_entries[@]}
  for i in "${!tool_json_entries[@]}"; do
    if [ "$i" -lt $((total - 1)) ]; then
      echo "${tool_json_entries[$i]},"
    else
      echo "${tool_json_entries[$i]}"
    fi
  done

  echo "  },"
  echo "  \"project_tools\": {"

  pt_entries=()
  for t in "${!PROJECT_TOOLS[@]}"; do
    s="${PROJECT_TOOLS[$t]}"
    avail="false"
    [ "$s" = "available" ] && avail="true"
    pt_entries+=("    \"${t}\": {\"available\": ${avail}}")
  done

  total=${#pt_entries[@]}
  if [ "$total" -eq 0 ]; then
    true  # empty object
  else
    for i in "${!pt_entries[@]}"; do
      if [ "$i" -lt $((total - 1)) ]; then
        echo "${pt_entries[$i]},"
      else
        echo "${pt_entries[$i]}"
      fi
    done
  fi

  echo "  },"
  echo "  \"detected_languages\": {"
  echo "    \"python\": ${has_python},"
  echo "    \"rust\": ${has_rust},"
  echo "    \"go\": ${has_go},"
  echo "    \"ruby\": ${has_ruby},"
  echo "    \"node\": ${has_node}"
  echo "  },"

  # Install commands for missing tools
  echo "  \"install_commands\": {"
  if [ ${#MISSING[@]} -gt 0 ]; then
    all_cmd=""
    first=true
    for cmd in "${MISSING_CMDS[@]}"; do
      $first || all_cmd="${all_cmd} && "
      all_cmd="${all_cmd}${cmd}"
      first=false
    done
    echo "    \"all_missing\": \"${all_cmd}\","
    echo "    \"per_tool\": {"
    total=${#MISSING[@]}
    for i in "${!MISSING[@]}"; do
      t="${MISSING[$i]}"
      cmd=$(install_cmd "$t")
      if [ "$i" -lt $((total - 1)) ]; then
        echo "      \"${t}\": \"${cmd}\","
      else
        echo "      \"${t}\": \"${cmd}\""
      fi
    done
    echo "    }"
  else
    echo "    \"all_missing\": null,"
    echo "    \"per_tool\": {}"
  fi
  echo "  }"

  echo "}"
} > "$OUTPUT_FILE"

echo "Wrote: ${OUTPUT_FILE}"

# Exit non-zero if jq is missing (hard requirement)
if [ "${STATUS[jq]}" = "missing" ]; then
  exit 1
fi

exit 0
