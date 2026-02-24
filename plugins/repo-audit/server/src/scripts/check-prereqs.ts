/**
 * Check for prerequisite tools and detect project environment.
 *
 * Migrated from scripts/check-prereqs.sh.
 *
 * Detects OS and package manager, checks tool availability,
 * detects project languages, and generates install commands.
 * This is read-only — it never installs anything.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform, release } from "node:os";
import { runScript } from "../lib/subprocess.js";
import type { ToolAvailability } from "../lib/types.js";

// ---------------------------------------------------------------------------
// OS / package manager detection
// ---------------------------------------------------------------------------

async function readOsRelease(): Promise<Record<string, string>> {
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile("/etc/os-release", "utf-8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+)=["']?([^"'\n]*)["']?$/);
      if (match) result[match[1]] = match[2];
    }
    return result;
  } catch {
    return {};
  }
}

async function detectOs(): Promise<string> {
  const p = platform();
  if (p === "darwin") return "macos";

  if (p === "linux") {
    const osRelease = await readOsRelease();
    const id = osRelease.ID ?? "";
    const debianLike = ["ubuntu", "debian", "pop", "linuxmint", "elementary"];
    if (debianLike.includes(id)) return "debian";
    if (id === "fedora") return "fedora";
    if (["rhel", "centos", "rocky", "alma", "ol"].includes(id)) return "rhel";
    if (["arch", "manjaro", "endeavouros"].includes(id)) return "arch";
    if (id === "alpine") return "alpine";

    // Fallback: check for known package managers
    try { await runScript("which", ["apt-get"], { timeout: 5000 }); return "debian"; } catch {}
    try { await runScript("which", ["dnf"], { timeout: 5000 }); return "fedora"; } catch {}
    try { await runScript("which", ["pacman"], { timeout: 5000 }); return "arch"; } catch {}
    try { await runScript("which", ["apk"], { timeout: 5000 }); return "alpine"; } catch {}

    return "linux";
  }

  return "unknown";
}

function detectPkgManager(os: string): string {
  const map: Record<string, string> = {
    macos: "brew",
    debian: "apt",
    fedora: "dnf",
    rhel: "yum",
    arch: "pacman",
    alpine: "apk",
  };
  return map[os] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Tool availability checking
// ---------------------------------------------------------------------------

async function toolPath(name: string): Promise<string> {
  try {
    const result = await runScript("which", [name], { timeout: 5000 });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function checkTool(name: string): Promise<boolean> {
  const path = await toolPath(name);
  return path !== "";
}

async function checkNpxTool(
  name: string,
  projectRoot: string,
): Promise<boolean> {
  const localBin = join(projectRoot, "node_modules", ".bin", name);
  try {
    await access(localBin);
    return true;
  } catch {
    // Fall back to global
    return checkTool(name);
  }
}

// ---------------------------------------------------------------------------
// Install command lookup tables
// ---------------------------------------------------------------------------

function installCmd(tool: string, pkg: string): string | undefined {
  const commands: Record<string, Record<string, string>> = {
    rg: {
      brew: "brew install ripgrep",
      apt: "sudo apt install -y ripgrep",
      dnf: "sudo dnf install -y ripgrep",
      yum: "sudo yum install -y ripgrep",
      pacman: "sudo pacman -S --noconfirm ripgrep",
      apk: "sudo apk add ripgrep",
      _default: "cargo install ripgrep",
    },
    tree: {
      brew: "brew install tree",
      apt: "sudo apt install -y tree",
      dnf: "sudo dnf install -y tree",
      yum: "sudo yum install -y tree",
      pacman: "sudo pacman -S --noconfirm tree",
      apk: "sudo apk add tree",
      _default: "# Install tree for your platform",
    },
    cloc: {
      brew: "brew install cloc",
      apt: "sudo apt install -y cloc",
      dnf: "sudo dnf install -y cloc",
      yum: "sudo yum install -y cloc",
      pacman: "sudo pacman -S --noconfirm cloc",
      apk: "sudo apk add cloc",
      _default: "npm install -g cloc",
    },
    tokei: {
      brew: "brew install tokei",
      pacman: "sudo pacman -S --noconfirm tokei",
      _default: "cargo install tokei",
    },
    "pip-audit": { _default: "pip install pip-audit" },
    "cargo-audit": { _default: "cargo install cargo-audit" },
    govulncheck: {
      _default: "go install golang.org/x/vuln/cmd/govulncheck@latest",
    },
    "bundle-audit": { _default: "gem install bundler-audit" },
  };

  const toolCmds = commands[tool];
  if (!toolCmds) return undefined;
  return toolCmds[pkg] ?? toolCmds._default;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface LanguageFlags {
  python: boolean;
  rust: boolean;
  go: boolean;
  ruby: boolean;
  node: boolean;
}

async function detectLanguages(projectRoot: string): Promise<LanguageFlags> {
  const [hasPython, hasRust, hasGo, hasRuby, hasNode] = await Promise.all([
    Promise.all([
      fileExists(join(projectRoot, "requirements.txt")),
      fileExists(join(projectRoot, "pyproject.toml")),
      fileExists(join(projectRoot, "setup.py")),
      fileExists(join(projectRoot, "Pipfile")),
    ]).then((results) => results.some(Boolean)),
    fileExists(join(projectRoot, "Cargo.toml")),
    fileExists(join(projectRoot, "go.mod")),
    fileExists(join(projectRoot, "Gemfile")),
    fileExists(join(projectRoot, "package.json")),
  ]);

  return {
    python: hasPython,
    rust: hasRust,
    go: hasGo,
    ruby: hasRuby,
    node: hasNode,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Check prerequisites and write tool-availability.json.
 *
 * @param projectRoot Path to the project root
 * @returns The tool availability data, also written to disk
 */
export async function checkPrereqs(
  projectRoot: string,
): Promise<ToolAvailability> {
  const outputDir = join(projectRoot, "sdlc-audit", "data");
  const outputFile = join(outputDir, "tool-availability.json");

  await mkdir(outputDir, { recursive: true });

  const os = await detectOs();
  const pkg = detectPkgManager(os);
  const languages = await detectLanguages(projectRoot);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Check core tools (Tier 0 + Tier 1 + Tier 2)
  const coreTools = ["rg", "tree", "cloc", "tokei"];
  const toolResults: Record<string, { available: boolean; path?: string }> = {};

  // Check all core tools in parallel
  const coreChecks = await Promise.all(
    coreTools.map(async (t) => {
      const path = await toolPath(t);
      return { name: t, available: path !== "", path };
    }),
  );
  for (const check of coreChecks) {
    toolResults[check.name] = {
      available: check.available,
      path: check.path || undefined,
    };
  }

  // Tier 3 — language-specific tools (check only if language detected)
  const tier3Checks: Array<Promise<{ name: string; available: boolean; path: string }>> = [];

  if (languages.python) {
    tier3Checks.push(
      toolPath("python3").then((p) => ({ name: "python3", available: p !== "", path: p })),
      toolPath("pip-audit").then((p) => ({ name: "pip_audit", available: p !== "", path: p })),
    );
  }
  if (languages.rust) {
    tier3Checks.push(
      toolPath("cargo-audit").then((p) => ({ name: "cargo_audit", available: p !== "", path: p })),
    );
  }
  if (languages.go) {
    tier3Checks.push(
      toolPath("govulncheck").then((p) => ({ name: "govulncheck", available: p !== "", path: p })),
    );
  }
  if (languages.ruby) {
    tier3Checks.push(
      toolPath("bundle-audit").then((p) => ({ name: "bundle_audit", available: p !== "", path: p })),
    );
  }

  const tier3Results = await Promise.all(tier3Checks);
  for (const check of tier3Results) {
    toolResults[check.name] = {
      available: check.available,
      path: check.path || undefined,
    };
  }

  // Project-local tools
  const projectTools: Record<string, { available: boolean }> = {};
  const projectChecks: Array<Promise<{ name: string; available: boolean }>> = [];

  if (languages.node) {
    projectChecks.push(
      checkNpxTool("tsc", projectRoot).then((a) => ({ name: "tsc", available: a })),
      checkNpxTool("eslint", projectRoot).then((a) => ({ name: "eslint", available: a })),
      checkNpxTool("biome", projectRoot).then((a) => ({ name: "biome", available: a })),
    );
  }
  if (languages.python) {
    projectChecks.push(
      checkTool("ruff").then((a) => ({ name: "ruff", available: a })),
      checkTool("mypy").then((a) => ({ name: "mypy", available: a })),
    );
  }
  if (languages.go) {
    projectChecks.push(
      checkTool("go").then((a) => ({ name: "go_vet", available: a })),
    );
  }
  if (languages.rust) {
    projectChecks.push(
      checkTool("cargo").then((a) => ({ name: "cargo_clippy", available: a })),
    );
  }

  const projectResults = await Promise.all(projectChecks);
  for (const check of projectResults) {
    projectTools[check.name] = { available: check.available };
  }

  // Build missing tools list and install commands
  // Map normalized names back to install-command names
  const installNameMap: Record<string, string> = {
    pip_audit: "pip-audit",
    cargo_audit: "cargo-audit",
    bundle_audit: "bundle-audit",
  };

  const missingTools: string[] = [];
  const perTool: Record<string, string> = {};

  const checkOrder = [
    "rg", "tree", "cloc", "tokei",
    "python3", "pip_audit", "cargo_audit", "govulncheck", "bundle_audit",
  ];

  for (const t of checkOrder) {
    const info = toolResults[t];
    if (!info || info.available) continue;

    // Skip tokei if cloc is available (only need one)
    if (t === "tokei" && toolResults.cloc?.available) continue;
    // Skip cloc if tokei is available
    if (t === "cloc" && toolResults.tokei?.available) continue;

    const installName = installNameMap[t] ?? t;
    const cmd = installCmd(installName, pkg);
    if (cmd) {
      missingTools.push(installName);
      perTool[installName] = cmd;
    }
  }

  const allMissing =
    missingTools.length > 0
      ? missingTools.map((t) => perTool[t]).join(" && ")
      : null;

  const result: ToolAvailability = {
    os,
    package_manager: pkg,
    timestamp,
    tools: toolResults,
    project_tools: projectTools,
    detected_languages: {
      python: languages.python,
      rust: languages.rust,
      go: languages.go,
      ruby: languages.ruby,
      node: languages.node,
    },
    install_commands: {
      all_missing: allMissing,
      per_tool: perTool,
    },
  };

  await writeFile(outputFile, JSON.stringify(result, null, 2));

  return result;
}
