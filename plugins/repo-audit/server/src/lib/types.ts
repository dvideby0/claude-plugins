/**
 * Shared type definitions for repo-audit data structures.
 *
 * These types represent the JSON schemas consumed and produced by the
 * migrated scripts. Types that already
 * exist in state.ts (AuditMeta, DetectionData) are re-exported here
 * for convenience.
 */

// Re-export existing types from state.ts so callers can import from one place.
export type { AuditMeta, DetectionData } from "./state.js";

// ---------------------------------------------------------------------------
// Module JSON — the core unit of analysis
// ---------------------------------------------------------------------------

export interface ModuleIssue {
  severity: "critical" | "warning" | "info";
  confidence?: "definite" | "high" | "medium" | "low";
  source?: "linter" | "typecheck" | "prescan" | "llm-analysis" | "cross-module";
  category?: string;
  description: string;
  suggestion?: string;
  line_range?: string | [number, number];
  impact?: string;
  remediation?: string;
  owasp?: string;
  guide_rule?: string;
}

export interface ModuleFileEntry {
  path: string;
  language?: string;
  lines?: number;
  issues: ModuleIssue[];
  functions?: Array<{ name: string; complexity?: string }>;
}

export interface ModuleLevelIssue {
  severity: "critical" | "warning" | "info";
  confidence?: string;
  category?: string;
  description: string;
  suggestion?: string;
  acceptance_criteria?: string;
}

export interface ModuleJson {
  directory: string;
  directories_analyzed?: string[];
  category?: string;
  languages_found?: string[];
  purpose?: string;
  file_count?: number;
  total_lines?: number;
  files: ModuleFileEntry[];
  internal_dependencies: Array<string | Record<string, unknown>>;
  external_dependencies: Array<string | Record<string, unknown>>;
  test_coverage: "full" | "partial" | "none" | "not-applicable" | "unknown";
  documentation_quality: "comprehensive" | "adequate" | "sparse" | "missing" | "unknown";
  module_level_issues?: ModuleLevelIssue[];
  sources?: string[];
  specialist_triage?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dependency graph — output of build-dep-graph
// ---------------------------------------------------------------------------

export interface ModuleGraphEntry {
  depends_on: string[];
  depended_on_by: string[];
  fan_in: number;
  fan_out: number;
  external_deps: string[];
}

export interface DependencyData {
  module_graph: Record<string, ModuleGraphEntry>;
  circular_dependencies: string[][];
  hub_modules: string[];
  orphan_modules: string[];
  external_dependencies: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Risk scores — output of compute-risk-scores
// ---------------------------------------------------------------------------

export interface RiskScoreEntry {
  module: string;
  total_lines: number;
  issue_count: number;
  weighted_issue_count: number;
  high_complexity: number;
  test_coverage: string;
  documentation_quality: string;
  fan_in: number;
  blast_radius: number;
  complexity: number;
  safety_net: number;
  risk_score: number;
}

export interface RiskScoresOutput {
  scores: RiskScoreEntry[];
  top_10_highest_risk: string[];
  risk_distribution: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

// ---------------------------------------------------------------------------
// Variant candidates — output of extract-variants
// ---------------------------------------------------------------------------

export interface SystemicPattern {
  count: number;
  files: string[];
  directories: string[];
  severity: string;
  category: string;
}

export interface SingleCritical {
  category: string;
  description: string;
  file: string;
  line_range?: string | [number, number];
  guide_rule: string;
  severity: string;
}

export interface VariantCandidates {
  systemic_patterns: Record<string, SystemicPattern>;
  single_critical: Record<string, SingleCritical>;
  category_distribution: Record<string, number>;
  total_high_severity: number;
}

// ---------------------------------------------------------------------------
// Tool availability — output of check-prereqs
// ---------------------------------------------------------------------------

export interface ToolAvailability {
  os: string;
  package_manager: string;
  timestamp: string;
  tools: Record<string, { available: boolean; path?: string }>;
  project_tools: Record<string, { available: boolean }>;
  detected_languages: Record<string, boolean>;
  install_commands: {
    all_missing: string | null;
    per_tool: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// Validation results — output of validate-module-json
// ---------------------------------------------------------------------------

export interface ValidationResults {
  validated: number;
  passed: number;
  failed: number;
  errors: Array<{ file: string; errors: string[] }>;
}

// ---------------------------------------------------------------------------
// Findings — input to merge-module-findings
// ---------------------------------------------------------------------------

export interface Finding {
  file: string;
  severity: string;
  description: string;
  confidence?: string;
  category?: string;
  source?: string;
  line_range?: string;
  impact?: string;
  remediation?: string;
  owasp?: string;
  guide_rule?: string;
}

export interface FindingsFile {
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Cross-module analysis structures
// ---------------------------------------------------------------------------

export interface CrossModuleDry {
  duplications: Array<{
    description: string;
    locations: string[];
    suggestion?: string;
    severity?: string;
    confidence?: string;
  }>;
}

export interface CrossModuleInconsistencies {
  inconsistencies: Array<{
    pattern_type?: string;
    description: string;
    examples: Array<string | { module: string }>;
    recommendation?: string;
    severity?: string;
    confidence?: string;
  }>;
}

export interface CrossModuleArchitecture {
  architecture_issues: Array<{
    type?: string;
    description: string;
    affected_modules?: string[];
    modules?: string[];
    suggestion?: string;
    severity?: string;
    confidence?: string;
  }>;
  dependency_interpretation?: {
    problematic_cycles?: Array<{ cycle: string[]; reason: string }>;
    hub_assessment?: Array<{ module: string; assessment: string }>;
    decoupling_suggestions?: string[];
  };
  duplicate_externals?: Array<{ package: string; issue: string }>;
}

export interface CrossModuleCoverage {
  test_gaps: Array<{
    module: string;
    coverage?: string;
    missing_types?: string[];
    priority?: string;
    risk_note?: string;
    description?: string;
  }>;
  doc_gaps?: Array<{
    module: string;
    coverage?: string;
    missing?: string[];
    priority?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Git analysis — output of git-analysis
// ---------------------------------------------------------------------------

export interface GitHotspot {
  changes: number;
  file: string;
}

export interface GitAnalysisResult {
  hotspotsWritten: boolean;
  busfactorWritten: boolean;
}
