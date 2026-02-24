import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, extname, basename, relative } from "node:path";

// ----- Excluded directory patterns -----
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  "vendor",
  ".venv",
  "venv",
  ".next",
  "target",
  "bin",
  "obj",
  ".gradle",
  ".idea",
  ".vs",
  "coverage",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  ".tox",
  "deps",
  "_build",
  ".dart_tool",
  ".pub-cache",
  "Pods",
  "sdlc-audit",
]);

function isExcluded(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

// ----- Extension → Language mapping -----
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rb": "ruby",
  ".rake": "ruby",
  ".erb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".swift": "swift",
  ".ex": "elixir",
  ".exs": "elixir",
  ".heex": "elixir",
  ".dart": "dart",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".scala": "scala",
  ".sc": "scala",
  ".yml": "config",
  ".yaml": "config",
  ".toml": "config",
  ".json": "config",
  ".md": "docs",
  ".rst": "docs",
  ".txt": "docs",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
};

// ----- Language → Guide file mapping -----
const LANGUAGE_TO_GUIDE: Record<string, string> = {
  typescript: "typescript.md",
  javascript: "typescript.md",
  python: "python.md",
  go: "go.md",
  rust: "rust.md",
  java: "java.md",
  kotlin: "java.md",
  ruby: "ruby.md",
  php: "php.md",
  csharp: "csharp.md",
  swift: "swift.md",
  elixir: "elixir.md",
  dart: "dart.md",
  c: "c_cpp.md",
  cpp: "c_cpp.md",
  scala: "scala.md",
  shell: "general.md",
  sql: "general.md",
  config: "infrastructure.md",
};

// ----- Manifest → Language mapping -----
interface ManifestPattern {
  glob: string;
  language: string;
}

const MANIFEST_PATTERNS: ManifestPattern[] = [
  { glob: "package.json", language: "typescript" },
  { glob: "tsconfig.json", language: "typescript" },
  { glob: "requirements.txt", language: "python" },
  { glob: "pyproject.toml", language: "python" },
  { glob: "setup.py", language: "python" },
  { glob: "setup.cfg", language: "python" },
  { glob: "Pipfile", language: "python" },
  { glob: "go.mod", language: "go" },
  { glob: "Cargo.toml", language: "rust" },
  { glob: "pom.xml", language: "java" },
  { glob: "build.gradle", language: "java" },
  { glob: "build.gradle.kts", language: "java" },
  { glob: "Gemfile", language: "ruby" },
  { glob: "composer.json", language: "php" },
  { glob: "Package.swift", language: "swift" },
  { glob: "mix.exs", language: "elixir" },
  { glob: "pubspec.yaml", language: "dart" },
  { glob: "CMakeLists.txt", language: "c" },
  { glob: "Makefile", language: "c" },
  { glob: "build.sbt", language: "scala" },
  { glob: "build.sc", language: "scala" },
  { glob: "deno.json", language: "typescript" },
  { glob: "deno.jsonc", language: "typescript" },
  { glob: "bun.lockb", language: "typescript" },
];

// ----- Framework detection patterns -----
interface FrameworkPattern {
  file: string;
  framework: string;
  language: string;
}

const FRAMEWORK_PATTERNS: FrameworkPattern[] = [
  { file: "next.config.js", framework: "next.js", language: "typescript" },
  { file: "next.config.mjs", framework: "next.js", language: "typescript" },
  { file: "next.config.ts", framework: "next.js", language: "typescript" },
  { file: "angular.json", framework: "angular", language: "typescript" },
  { file: "svelte.config.js", framework: "sveltekit", language: "typescript" },
  { file: "nuxt.config.ts", framework: "nuxt", language: "typescript" },
  { file: "nuxt.config.js", framework: "nuxt", language: "typescript" },
  { file: "astro.config.mjs", framework: "astro", language: "typescript" },
  { file: "astro.config.ts", framework: "astro", language: "typescript" },
  { file: "remix.config.js", framework: "remix", language: "typescript" },
  { file: "manage.py", framework: "django", language: "python" },
  { file: "config/routes.rb", framework: "rails", language: "ruby" },
  { file: "artisan", framework: "laravel", language: "php" },
  { file: "bin/console", framework: "symfony", language: "php" },
  { file: "application.conf", framework: "play", language: "scala" },
];

// ----- Directory category classification -----
type DirCategory =
  | "source"
  | "tests"
  | "scripts"
  | "config"
  | "ci_cd"
  | "infrastructure"
  | "database"
  | "docs"
  | "generated"
  | "vendored";

const CATEGORY_PATTERNS: { pattern: RegExp; category: DirCategory }[] = [
  { pattern: /^(tests?|__tests__|spec|specs|testing)$/i, category: "tests" },
  {
    pattern: /[/\\](tests?|__tests__|spec|specs|testing)$/i,
    category: "tests",
  },
  { pattern: /^(e2e|cypress|playwright)$/i, category: "tests" },
  { pattern: /[/\\](e2e|cypress|playwright)$/i, category: "tests" },
  { pattern: /^\.github$/i, category: "ci_cd" },
  { pattern: /^\.github[/\\]workflows$/i, category: "ci_cd" },
  { pattern: /^\.circleci$/i, category: "ci_cd" },
  { pattern: /^(scripts?|bin|tools?)$/i, category: "scripts" },
  { pattern: /[/\\](scripts?|bin|tools?)$/i, category: "scripts" },
  { pattern: /^(docs?|documentation)$/i, category: "docs" },
  { pattern: /[/\\](docs?|documentation)$/i, category: "docs" },
  {
    pattern: /^(terraform|k8s|kubernetes|helm|ansible|infra|infrastructure|deploy|deployment)$/i,
    category: "infrastructure",
  },
  {
    pattern:
      /[/\\](terraform|k8s|kubernetes|helm|ansible|infra|infrastructure|deploy|deployment)$/i,
    category: "infrastructure",
  },
  {
    pattern: /^(db|database|migrations?|seeds?|schema)$/i,
    category: "database",
  },
  {
    pattern: /[/\\](db|database|migrations?|seeds?|schema)$/i,
    category: "database",
  },
  {
    pattern: /^(generated|auto-generated|codegen|\.generated)$/i,
    category: "generated",
  },
  {
    pattern: /[/\\](generated|auto-generated|codegen|\.generated)$/i,
    category: "generated",
  },
  { pattern: /^(vendor|third[_-]?party|external)$/i, category: "vendored" },
  {
    pattern: /[/\\](vendor|third[_-]?party|external)$/i,
    category: "vendored",
  },
];

export function classifyDirectory(dirPath: string): DirCategory {
  const normalized = dirPath.replace(/\\/g, "/").replace(/\/$/, "");

  // Check the path itself
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (pattern.test(normalized)) {
      return category;
    }
  }

  // Check if any ancestor segment matches a category pattern
  // e.g., "tests/fixtures/modules" should inherit "tests" from "tests"
  const parts = normalized.split("/");
  for (let i = 0; i < parts.length; i++) {
    const partial = parts.slice(0, i + 1).join("/");
    for (const { pattern, category } of CATEGORY_PATTERNS) {
      if (pattern.test(partial)) {
        return category;
      }
    }
  }

  // Root config files
  if (normalized === "." || normalized === "_root_") {
    return "config";
  }

  return "source";
}

export function getLanguageFromExtension(ext: string): string | null {
  return EXTENSION_TO_LANGUAGE[ext.toLowerCase()] ?? null;
}

export function getGuideFile(language: string, pluginRoot: string): string {
  const guide = LANGUAGE_TO_GUIDE[language] ?? "general.md";
  return join(pluginRoot, "lang", guide);
}

export function getGuideFilesForLanguages(
  languages: string[],
  pluginRoot: string,
): string[] {
  const guides = new Set<string>();
  for (const lang of languages) {
    guides.add(getGuideFile(lang, pluginRoot));
  }
  return [...guides];
}

// ----- Directory scanning -----

interface FileInfo {
  path: string;
  ext: string;
  size: number;
}

interface DirInfo {
  relativePath: string;
  category: DirCategory;
  files: FileInfo[];
  languages: string[];
  guideFiles: string[];
  fileCount: number;
}

async function scanDirectory(
  basePath: string,
  currentPath: string,
  results: Map<string, DirInfo>,
  pluginRoot: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  const relPath = relative(basePath, currentPath) || ".";
  const files: FileInfo[] = [];
  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    if (isExcluded(entry.name) && entry.isDirectory()) continue;

    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      subdirs.push(fullPath);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      let size = 0;
      try {
        const s = await stat(fullPath);
        size = s.size;
      } catch {
        // skip unreadable files
      }
      files.push({ path: relative(basePath, fullPath), ext, size });
    }
  }

  // Only add directories that have files (or are the root)
  if (files.length > 0 || relPath === ".") {
    const langSet = new Set<string>();
    for (const f of files) {
      const lang = getLanguageFromExtension(f.ext);
      if (lang) langSet.add(lang);
    }
    const languages = [...langSet];

    const category = classifyDirectory(relPath);
    const guideFiles = getGuideFilesForLanguages(languages, pluginRoot);

    // Config, ci_cd, and infrastructure directories always get infrastructure.md
    if (["config", "ci_cd", "infrastructure"].includes(category)) {
      const infraGuide = join(pluginRoot, "lang", "infrastructure.md");
      if (!guideFiles.includes(infraGuide)) {
        guideFiles.push(infraGuide);
      }
    }

    const dirKey = relPath === "." ? "_root_" : relPath + "/";
    results.set(dirKey, {
      relativePath: relPath,
      category,
      files,
      languages,
      guideFiles,
      fileCount: files.length,
    });
  }

  // Recurse into subdirectories
  for (const subdir of subdirs) {
    await scanDirectory(basePath, subdir, results, pluginRoot);
  }
}

// ----- Manifest scanning -----

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface ManifestResult {
  languages: Set<string>;
  frameworks: Record<string, string[]>;
  monorepo: boolean;
  packageManagers: Record<string, string>;
}

async function scanManifests(projectRoot: string): Promise<ManifestResult> {
  const languages = new Set<string>();
  const frameworks: Record<string, string[]> = {};
  let monorepo = false;
  const packageManagers: Record<string, string> = {};

  // Check root-level manifests
  for (const mp of MANIFEST_PATTERNS) {
    if (await fileExists(join(projectRoot, mp.glob))) {
      languages.add(mp.language);
    }
  }

  // Check framework config files
  for (const fp of FRAMEWORK_PATTERNS) {
    if (await fileExists(join(projectRoot, fp.file))) {
      if (!frameworks[fp.language]) frameworks[fp.language] = [];
      if (!frameworks[fp.language].includes(fp.framework)) {
        frameworks[fp.language].push(fp.framework);
      }
    }
  }

  // Detect monorepo patterns
  for (const indicator of [
    "lerna.json",
    "pnpm-workspace.yaml",
    "rush.json",
    "nx.json",
  ]) {
    if (await fileExists(join(projectRoot, indicator))) {
      monorepo = true;
      break;
    }
  }

  // Also check package.json for workspaces
  try {
    const pkgPath = join(projectRoot, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    if (pkg.workspaces) monorepo = true;

    // Detect package manager
    if (await fileExists(join(projectRoot, "pnpm-lock.yaml"))) {
      packageManagers["js"] = "pnpm";
    } else if (await fileExists(join(projectRoot, "yarn.lock"))) {
      packageManagers["js"] = "yarn";
    } else if (await fileExists(join(projectRoot, "bun.lockb"))) {
      packageManagers["js"] = "bun";
    } else if (await fileExists(join(projectRoot, "package-lock.json"))) {
      packageManagers["js"] = "npm";
    }
  } catch {
    // no package.json
  }

  // Detect Python package manager
  if (await fileExists(join(projectRoot, "poetry.lock"))) {
    packageManagers["python"] = "poetry";
  } else if (await fileExists(join(projectRoot, "Pipfile.lock"))) {
    packageManagers["python"] = "pipenv";
  } else if (await fileExists(join(projectRoot, "uv.lock"))) {
    packageManagers["python"] = "uv";
  }

  return { languages, frameworks, monorepo, packageManagers };
}

// ----- Main detection function -----

export interface DetectionResult {
  primary_languages: string[];
  secondary_languages: string[];
  frameworks: Record<string, string[]>;
  tooling: Record<string, unknown>;
  monorepo: boolean;
  package_managers: Record<string, string>;
  total_source_files: number;
  total_directories: number;
  all_directories: Record<
    string,
    {
      category: string;
      est_files: number;
      languages: string[];
      guide_files: string[];
    }
  >;
}

export async function runDetection(
  projectRoot: string,
  pluginRoot: string,
): Promise<DetectionResult> {
  // Scan all directories
  const dirMap = new Map<string, DirInfo>();
  await scanDirectory(projectRoot, projectRoot, dirMap, pluginRoot);

  // Scan manifests
  const manifestResult = await scanManifests(projectRoot);

  // Aggregate languages across all directories
  const languageCounts = new Map<string, number>();
  let totalFiles = 0;

  for (const [, info] of dirMap) {
    totalFiles += info.fileCount;
    for (const lang of info.languages) {
      languageCounts.set(lang, (languageCounts.get(lang) ?? 0) + info.fileCount);
    }
  }

  // Also include manifest-detected languages
  for (const lang of manifestResult.languages) {
    if (!languageCounts.has(lang)) {
      languageCounts.set(lang, 0);
    }
  }

  // Split into primary (>5% of files or from manifests) and secondary
  const primaryThreshold = Math.max(totalFiles * 0.05, 1);
  const primary: string[] = [];
  const secondary: string[] = [];

  for (const [lang, count] of languageCounts) {
    if (
      ["docs", "config"].includes(lang) ||
      lang === "shell" ||
      lang === "sql"
    ) {
      secondary.push(lang);
    } else if (count >= primaryThreshold || manifestResult.languages.has(lang)) {
      primary.push(lang);
    } else {
      secondary.push(lang);
    }
  }

  // Build all_directories map
  const allDirs: DetectionResult["all_directories"] = {};
  for (const [key, info] of dirMap) {
    allDirs[key] = {
      category: info.category,
      est_files: info.fileCount,
      languages: info.languages,
      guide_files: info.guideFiles,
    };
  }

  return {
    primary_languages: primary.sort(),
    secondary_languages: secondary.sort(),
    frameworks: manifestResult.frameworks,
    tooling: {}, // filled in by audit_run_tools or check-prereqs
    monorepo: manifestResult.monorepo,
    package_managers: manifestResult.packageManagers,
    total_source_files: totalFiles,
    total_directories: dirMap.size,
    all_directories: allDirs,
  };
}

export async function writeDetectionJson(
  auditDir: string,
  detection: DetectionResult,
): Promise<string> {
  const dataDir = join(auditDir, "data");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(auditDir, "modules"), { recursive: true });
  const outPath = join(dataDir, "detection.json");
  await writeFile(outPath, JSON.stringify(detection, null, 2));
  return outPath;
}

export async function readDetectionJson(
  auditDir: string,
): Promise<DetectionResult | null> {
  try {
    const data = await readFile(join(auditDir, "data", "detection.json"), "utf-8");
    return JSON.parse(data) as DetectionResult;
  } catch {
    return null;
  }
}
