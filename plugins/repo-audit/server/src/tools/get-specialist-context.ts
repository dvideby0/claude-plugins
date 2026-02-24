import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { getState } from "../lib/state.js";
import { estimateTokens, fitsInBudget } from "../lib/tokens.js";

// ----- Interfaces -----

interface GetSpecialistContextInput {
  domain: string;
  tokenBudget?: number;
}

interface GetSpecialistContextResult {
  domain: string;
  taskPrompt: string;
  tokenEstimate: number;
  filesIncluded: number;
  outputPath: string;
}

// ----- Domain → guide section mapping -----

/**
 * Maps specialist domains to relevant section headings in language guides.
 * Used to extract only the pertinent portions of guides for each specialist.
 */
const DOMAIN_GUIDE_SECTIONS: Record<string, string[]> = {
  error_handling: ["Error Handling", "Async Patterns", "Exception", "Recovery"],
  security: ["Security", "Authentication", "Authorization", "Input Validation", "Injection", "Secrets", "OWASP", "Node.js / Server-Side"],
  type_design: ["Type Safety", "Type", "Interface", "Generic", "Struct"],
  test_quality: ["Test", "Coverage", "Mock", "Fixture", "Assert"],
  performance: ["Performance", "Memory", "Caching", "N+1", "Query", "Optimization"],
  complexity: ["Complexity", "Refactor", "Module Patterns", "Architecture", "God"],
};

// ----- Helpers -----

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the specialist agent markdown file, stripping YAML frontmatter.
 */
async function readAgentPrompt(
  pluginRoot: string,
  agentFile: string,
): Promise<string> {
  const agentPath = join(pluginRoot, "agents", `${agentFile}.md`);
  try {
    const content = await readFile(agentPath, "utf-8");
    // Strip YAML frontmatter (---\n...\n---)
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return fmMatch ? fmMatch[1].trim() : content.trim();
  } catch {
    return getDefaultAgentPrompt(agentFile);
  }
}

/**
 * Fallback prompt if a specialist agent markdown file is missing.
 */
function getDefaultAgentPrompt(agentFile: string): string {
  const domainName = agentFile.replace("-specialist", "").replace(/-/g, " ");
  return `You are a ${domainName} specialist reviewer.

Analyze the flagged files below for ${domainName} concerns. For each issue found:
1. Identify the specific file and line range
2. Describe the issue clearly
3. Explain the impact
4. Suggest a concrete fix
5. Rate severity (critical/warning/info) and confidence (definite/high/medium/low)

Focus on actionable findings. Do not repeat issues already identified in module analysis.`;
}

/**
 * Extract relevant sections from language guide files based on specialist domain.
 */
async function extractGuideSection(
  guideFiles: string[],
  domain: string,
): Promise<string> {
  const sectionKeywords = DOMAIN_GUIDE_SECTIONS[domain] ?? [];
  if (sectionKeywords.length === 0) return "";

  const parts: string[] = [];

  for (const guidePath of guideFiles) {
    try {
      const content = await readFile(guidePath, "utf-8");
      const guideName = guidePath.split("/").pop() ?? "";

      // Split by markdown headings (## or ###)
      const sections = content.split(/(?=^#{2,3}\s)/m);
      const relevantSections: string[] = [];

      for (const section of sections) {
        const headingMatch = section.match(/^#{2,3}\s+(.+)$/m);
        if (!headingMatch) continue;

        const heading = headingMatch[1];
        // Check if this section heading matches any keywords for this domain
        const isRelevant = sectionKeywords.some((keyword) =>
          heading.toLowerCase().includes(keyword.toLowerCase()),
        );

        if (isRelevant) {
          relevantSections.push(section.trim());
        }
      }

      if (relevantSections.length > 0) {
        parts.push(`--- ${guideName} (${domain}-relevant sections) ---`);
        parts.push(relevantSections.join("\n\n"));
      }
    } catch {
      // Guide file not found — skip
    }
  }

  return parts.join("\n\n");
}

/**
 * Collect triage notes and flagged file paths from all modules for a domain.
 */
async function collectTriageData(
  auditDir: string,
  domain: string,
): Promise<{ flaggedFiles: string[]; triageNotes: string[] }> {
  const modulesDir = join(auditDir, "modules");
  const flaggedFiles: string[] = [];
  const triageNotes: string[] = [];

  try {
    const entries = await readdir(modulesDir);
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await readFile(join(modulesDir, file), "utf-8");
        const module = JSON.parse(data);
        const moduleId = module.directory ?? file.replace(/\.json$/, "");
        const triage = module.specialist_triage?.[domain];

        if (triage && triage.files_flagged?.length > 0) {
          flaggedFiles.push(...triage.files_flagged);
          if (triage.reason) {
            triageNotes.push(`[${moduleId}] ${triage.reason}`);
          }
        }
      } catch {
        // Skip unreadable modules
      }
    }
  } catch {
    // No modules directory
  }

  return { flaggedFiles: [...new Set(flaggedFiles)], triageNotes };
}

/**
 * Read flagged file contents within token budget.
 * File references may include line numbers (e.g., "src/auth/login.ts:42").
 */
async function readFlaggedFiles(
  projectRoot: string,
  flaggedFiles: string[],
  tokenBudget: number,
  currentTokens: number,
): Promise<{ content: string; filesIncluded: number }> {
  let tokensUsed = currentTokens;
  let filesIncluded = 0;
  const parts: string[] = [];
  const processedPaths = new Set<string>();

  for (const ref of flaggedFiles) {
    // Strip line number suffix
    const filePath = ref.replace(/:\d+$/, "");
    if (processedPaths.has(filePath)) continue;
    processedPaths.add(filePath);

    const fullPath = join(projectRoot, filePath);
    try {
      const content = await readFile(fullPath, "utf-8");
      const fileTokens = estimateTokens(content);

      if (fitsInBudget(tokensUsed, fileTokens, tokenBudget)) {
        // Truncate very large files
        const lines = content.split("\n");
        let fileContent: string;
        if (lines.length > 500) {
          const head = lines.slice(0, 200).join("\n");
          const tail = lines.slice(-100).join("\n");
          fileContent = `${head}\n\n... [${lines.length - 300} lines truncated] ...\n\n${tail}`;
        } else {
          fileContent = content;
        }

        parts.push(`--- ${filePath} ---`);
        parts.push(fileContent);
        parts.push("");
        tokensUsed += estimateTokens(fileContent);
        filesIncluded++;
      } else {
        parts.push(`--- ${filePath} [skipped — budget exceeded] ---`);
      }
    } catch {
      // File not found or unreadable
      parts.push(`--- ${filePath} [not found] ---`);
    }
  }

  return { content: parts.join("\n"), filesIncluded };
}

/**
 * Read prescan/linter data relevant to flagged files.
 */
async function readToolDataForFiles(
  auditDir: string,
  flaggedFiles: string[],
): Promise<string> {
  const parts: string[] = [];

  // Prescan summary (project-wide, include as-is for context)
  try {
    const prescan = await readFile(
      join(auditDir, "prescan", "prescan-summary.txt"),
      "utf-8",
    );
    if (prescan.trim()) {
      parts.push("=== PRESCAN SUMMARY ===");
      parts.push(prescan.trim());
      parts.push("");
    }
  } catch {
    // No prescan data
  }

  // Linter results filtered to flagged files
  const linterDir = join(auditDir, "tool-output", "linter-results");
  try {
    const linterFiles = await readdir(linterDir);
    for (const file of linterFiles) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await readFile(join(linterDir, file), "utf-8");
        const parsed = JSON.parse(data);

        if (Array.isArray(parsed)) {
          // ESLint format: filter to relevant files
          const stripped = flaggedFiles.map((f) => f.replace(/:\d+$/, ""));
          const filtered = parsed.filter((entry: any) => {
            if (!entry.filePath) return false;
            return stripped.some((f) => entry.filePath.includes(f));
          });
          if (filtered.length > 0) {
            parts.push(`=== LINTER: ${file} ===`);
            parts.push(JSON.stringify(filtered, null, 2));
            parts.push("");
          }
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // No linter dir
  }

  return parts.join("\n");
}

// ----- Output schema for specialist findings -----

function getOutputSchema(domain: string, outputPath: string): string {
  return `Write your findings to ${outputPath}:

\`\`\`json
{
  "domain": "${domain}",
  "findings": [
    {
      "file": "path/to/file.ts",
      "line_range": "10-25",
      "description": "Clear description of the issue",
      "impact": "Why this matters",
      "suggestion": "Concrete fix recommendation",
      "severity": "critical | warning | info",
      "confidence": "definite | high | medium | low",
      "category": "${domain}"
    }
  ],
  "summary": "Overall assessment of ${domain.replace(/_/g, " ")} in the codebase",
  "recommendations": [
    "Actionable recommendation 1",
    "Actionable recommendation 2"
  ]
}
\`\`\``;
}

// ----- Main tool function -----

export async function getSpecialistContext(
  input: GetSpecialistContextInput,
  pluginRoot: string,
): Promise<GetSpecialistContextResult> {
  const state = getState();
  if (!state) {
    throw new Error("State not initialized. Call audit_discover first.");
  }

  const { domain, tokenBudget: inputBudget } = input;
  const tokenBudget = inputBudget ?? 100_000;
  const auditDir = state.auditDir;
  const projectRoot = state.projectRoot;

  // Verify this domain is in the specialist plan
  const plan = state.specialistPlan;
  const specialistEntry = plan?.specialists.find((s) => s.domain === domain);
  if (!specialistEntry && !plan) {
    throw new Error("No specialist plan found. Call audit_plan_specialists first.");
  }

  // Determine agent file name
  const agentFile = specialistEntry?.agentFile ?? `${domain.replace(/_/g, "-")}-specialist`;

  // Output path
  const outputPath = join(auditDir, "specialists", `${domain}-findings.json`);

  // Assemble context with token tracking
  let tokensUsed = 0;
  const promptParts: string[] = [];

  // 1. Agent system prompt
  const agentPrompt = await readAgentPrompt(pluginRoot, agentFile);
  promptParts.push(agentPrompt);
  promptParts.push("");
  tokensUsed += estimateTokens(agentPrompt);

  // 2. Collect triage data
  const { flaggedFiles, triageNotes } = await collectTriageData(auditDir, domain);

  if (triageNotes.length > 0) {
    promptParts.push("=== TRIAGE NOTES FROM MODULE ANALYSIS ===");
    promptParts.push(triageNotes.join("\n"));
    promptParts.push("=== END TRIAGE NOTES ===");
    promptParts.push("");
    tokensUsed += estimateTokens(triageNotes.join("\n"));
  }

  // 3. Relevant language guide sections
  // Collect unique guide files from module assignments
  const guideFiles = [...new Set(state.moduleAssignments.flatMap((a) => a.guideFiles))];
  const guideContent = await extractGuideSection(guideFiles, domain);
  if (guideContent) {
    promptParts.push("=== RELEVANT LANGUAGE GUIDE SECTIONS ===");
    promptParts.push(guideContent);
    promptParts.push("=== END GUIDE SECTIONS ===");
    promptParts.push("");
    tokensUsed += estimateTokens(guideContent);
  }

  // 4. Prescan/linter data for flagged files
  const toolData = await readToolDataForFiles(auditDir, flaggedFiles);
  if (toolData) {
    promptParts.push(toolData);
    tokensUsed += estimateTokens(toolData);
  }

  // 5. Flagged file contents (budget-limited)
  if (flaggedFiles.length > 0) {
    promptParts.push("=== FLAGGED SOURCE FILES ===");
    const { content: fileContent, filesIncluded } = await readFlaggedFiles(
      projectRoot,
      flaggedFiles,
      tokenBudget,
      tokensUsed,
    );
    promptParts.push(fileContent);
    promptParts.push("=== END SOURCE FILES ===");
    promptParts.push("");
    tokensUsed += estimateTokens(fileContent);

    // 6. Output schema
    const schema = getOutputSchema(domain, outputPath);
    promptParts.push(schema);
    tokensUsed += estimateTokens(schema);

    const fullPrompt = promptParts.join("\n");

    return {
      domain,
      taskPrompt: fullPrompt,
      tokenEstimate: estimateTokens(fullPrompt),
      filesIncluded,
      outputPath,
    };
  }

  // No flagged files — still return a prompt but note it
  promptParts.push("No specific files were flagged for this domain by module analysis.");
  promptParts.push("Perform a general review of the codebase for " + domain.replace(/_/g, " ") + " concerns.");
  promptParts.push("");
  promptParts.push(getOutputSchema(domain, outputPath));

  const fullPrompt = promptParts.join("\n");

  return {
    domain,
    taskPrompt: fullPrompt,
    tokenEstimate: estimateTokens(fullPrompt),
    filesIncluded: 0,
    outputPath,
  };
}
