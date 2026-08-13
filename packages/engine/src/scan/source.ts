/**
 * Where scanned files come from.
 *
 * The bundled Rust core is the single production implementation. Keeping a
 * weaker TypeScript walker/parser in parallel made source policy drift possible
 * and forced every scanner change through two implementations.
 */

import { createRequire } from "node:module";

export type SourceLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "config"
  | "docs"
  | "other";

export interface ParsedSymbol {
  kind: "function" | "method" | "class" | "interface" | "type" | "enum" | "constant";
  name: string;
  /** Identity that survives cosmetic edits, unlike the positional `id`. */
  symbolKey: string;
  /** The contract callers depend on: the declaration without its body. */
  interfaceSha: string;
  /** The implementation. Absent where the declaration has no body. */
  bodySha?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  exported: boolean;
  defaultExport: boolean;
  signature: string;
}

export interface ParsedSource {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  executionEntries: ParsedExecutionEntry[];
  /** The file's meaning with comments and formatting removed. */
  syntaxSha: string;
  /** The sorted set of modules and imported names this file depends on. */
  relationSetSha: string;
}

export interface ParsedImport {
  specifier: string;
  startLine: number;
  endLine: number;
}

export interface ParsedExecutionNode {
  id: string;
  ordinal: number;
  kind: string;
  label: string;
  path: string;
  symbol: string;
  targetSymbol: string;
  targetLine: number;
  targetColumn: number;
  external: string;
  startLine: number;
  endLine: number;
  certainty: string;
  terminal: boolean;
  detail: string;
}

export interface ParsedExecutionEdge {
  ordinal: number;
  from: string;
  to: string;
  kind: string;
  label: string;
  path: string;
  startLine: number;
  certainty: string;
}

export interface ParsedExecutionEntry {
  id: string;
  kind: string;
  label: string;
  method: string;
  route: string;
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
  producerId: string;
  producerVersion: string;
  producerKind: string;
  certainty: string;
  nodes: ParsedExecutionNode[];
  edges: ParsedExecutionEdge[];
  diagnostics: string[];
}

/** A use of an imported name, before the specifier is resolved to a file. */
export interface SourceRef {
  name: string;
  module: string;
  line: number;
  column: number;
}

export interface SourceFile {
  path: string;
  lang: SourceLanguage;
  loc: number;
  bytes: number;
  contentSha: string;
  isTest: boolean;
  /**
   * Whether a grammar covers this file at all — a property of the file, not of
   * this run. Kept apart from `parsed`, which says whether this run actually
   * produced output for it. Once a scan can skip reading an unchanged file the
   * two diverge, and conflating them would flip `files.parsed` to 0 for every
   * skipped source file.
   */
  parseable: boolean;
  parsed: ParsedSource | null;
  refs: SourceRef[];
  /**
   * The filesystem's identity for this file, or null when it cannot serve as a
   * baseline for a later scan. Null never means unchanged.
   */
  statKey: string | null;
}

export interface SourceTextFile {
  path: string;
  lang: SourceLanguage;
  contentSha: string;
  isTest: boolean;
  content: string;
}

/**
 * Why a path is or is not part of the trusted inventory.
 *
 * A closed value set shared with the Rust input policy and stored in the
 * workspace database, so the strings are part of the contract, not display text.
 */
export const EXCLUSION_REASONS = ["app_owned_artifact", "packaged_application", "generated_output", "ignored_directory", "hidden_path", "unsupported_extension", "too_large", "binary_content", "unreadable", "noise", "source"] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface SourcePathDecision {
  language: SourceLanguage;
  included: boolean;
  /** Indexed files that are still never parsed: lockfiles and bundled output. */
  parseable: boolean;
  reason: ExclusionReason;
  /** Which rule decided it, phrased for a person. */
  detail: string;
  /**
   * Not indexed, but editing it changes the source set, so a watch refresh
   * must still run. Today: `.gitignore`.
   */
  policyInput: boolean;
}

export interface SourceExclusion {
  path: string;
  directory: boolean;
  reason: ExclusionReason;
  detail: string;
}

/** `paths` is the true count; `recorded` is how many are listed individually. */
export interface ExclusionCount {
  reason: ExclusionReason;
  paths: number;
  recorded: number;
}

interface NativeFile {
  path: string;
  lang: string;
  loc: number;
  bytes: number;
  contentSha: string;
  isTest: boolean;
  parsed: boolean;
  /** Absent when the observation cannot serve as a baseline for a later scan. */
  statKey?: string;
  syntaxSha: string;
  relationSetSha: string;
  symbols: Array<{
    kind: string;
    name: string;
    symbolKey: string;
    interfaceSha: string;
    bodySha?: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    exported: boolean;
    defaultExport: boolean;
    signature: string;
  }>;
  imports: ParsedImport[];
  refs: Array<{ name: string; module: string; line: number; column: number }>;
  executionEntries: ParsedExecutionEntry[];
}

export interface NativeScipDocument {
  path: string;
  occurrences: number;
  definitions: number;
  imports: number;
  references: number;
}

export interface NativeScipSummary {
  toolName: string;
  toolVersion: string;
  projectRoot: string;
  documents: number;
  occurrences: number;
  definitions: number;
  imports: number;
  references: number;
  relationships: number;
  externalSymbols: number;
  bytes: number;
  sha256: string;
  sampleDocuments: NativeScipDocument[];
}

export interface NativeScipRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface NativeScipOccurrence {
  path: string;
  range?: NativeScipRange;
  positionEncoding: string;
  symbolKey: string;
  symbol: string;
  kind: "definition" | "import" | "reference" | "read" | "write";
  nativeKind: string;
  ambiguous: boolean;
}

export interface NativeScipProjection {
  sha256: string;
  pathAliases: NativeScipPathAlias[];
  pathAliasSignature: string;
  documents: Array<{ path: string; language: string }>;
  symbols: Array<{
    key: string;
    symbol: string;
    displayName: string;
    kind: string;
    path?: string;
    external: boolean;
    ambiguous: boolean;
  }>;
  occurrences: NativeScipOccurrence[];
  relationships: Array<{
    path?: string;
    sourceKey: string;
    sourceSymbol: string;
    targetKey: string;
    targetSymbol: string;
    kind: "implement" | "reference";
    nativeKind: string;
    ambiguous: boolean;
  }>;
}

export interface NativeScipPathAlias {
  /** Lexically normalized document path emitted by the provider. */
  providerPath: string;
  /** Manifest spelling observed while the staged input still existed. */
  path: string;
}

export interface NativeStagedSnapshot {
  sourceSignature: string;
  files: number;
  bytes: number;
}

export interface NativeSnapshotEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface NativeSnapshotManifest {
  inputSignature: string;
  files: number;
  bytes: number;
  entries: NativeSnapshotEntry[];
  pathAliases?: NativeScipPathAlias[];
  pathAliasSignature?: string;
}

export interface NativeCore {
  scanRepo(root: string): Promise<{
    files: NativeFile[];
    exclusions: SourceExclusion[];
    exclusionSummary: ExclusionCount[];
    diagnostic?: string;
    gitignoreApplied: boolean;
    walkMs: number;
    parseMs: number;
  }>;
  /** Read source text through the same bounded inventory policy used by scans. */
  readRepoFiles(root: string): Promise<SourceTextFile[]>;
  /**
   * Ask the repository input policy about one path, and why.
   *
   * The same function the scan walk uses, so a watcher decision and an
   * inventory decision cannot disagree.
   */
  sourcePathDecision(
    path: string,
    root?: string,
    directory?: boolean,
    ignoreGitignore?: boolean,
  ): SourcePathDecision;
  /** Present in native cores that can consume official SCIP protobuf output. */
  inspectScip?(path: string): Promise<NativeScipSummary>;
  /** Decode bounded semantic facts without exposing raw protobufs to Node. */
  projectScip?(
    path: string,
    expectedSourceRoot: string,
    pathAliases: NativeScipPathAlias[],
  ): Promise<NativeScipProjection>;
  /** Freeze exactly the indexed source generation before an external provider reads it. */
  stageSourceSnapshot?(
    root: string,
    destination: string,
    expectedSignature: string,
  ): Promise<NativeStagedSnapshot>;
  /** Attest every input in a staged provider view before and after execution. */
  snapshotManifest?(root: string): Promise<NativeSnapshotManifest>;
  /** Recompute counts and the signature of retained input-manifest entries. */
  verifySnapshotManifest?(manifest: NativeSnapshotManifest): Promise<boolean>;
}

let nativeLookedUp = false;
let native: NativeCore | null = null;
let nativeLoadFailure: string | null = null;

/** Resolve the native core once so capability views can report an absent binary. */
export function loadNative(): NativeCore | null {
  if (nativeLookedUp) return native;
  nativeLookedUp = true;

  try {
    const require = createRequire(import.meta.url);
    const candidate = require("@sdlc/scan-core") as Partial<NativeCore>;
    if (
      typeof candidate.scanRepo !== "function" ||
      typeof candidate.readRepoFiles !== "function" ||
      typeof candidate.sourcePathDecision !== "function"
    ) {
      throw new Error("the installed binary does not expose the current source-inventory API");
    }
    native = candidate as NativeCore;
  } catch (error) {
    nativeLoadFailure = error instanceof Error ? error.message : String(error);
    native = null;
  }
  return native;
}

/** Production indexing cannot silently downgrade to a less capable engine. */
export function requireNative(): NativeCore {
  const core = loadNative();
  if (core) return core;
  throw new Error(
    `The bundled Rust scan core is unavailable${
      nativeLoadFailure ? `: ${nativeLoadFailure}` : "."
    } Reinstall or rebuild @sdlc/scan-core for this platform.`,
  );
}

/**
 * Classify one path through the Rust-owned input policy.
 *
 * Pass `root` so the repository's own committed `.gitignore` participates;
 * without it only the path shape decides. `directory` separates `dist/` the
 * build directory from `dist.ts` the source file — the one thing a path string
 * cannot say by itself. Omit it when the caller genuinely cannot tell, which is
 * the watcher's case for a rename.
 */
export function sourcePathDecision(
  path: string,
  root?: string,
  directory?: boolean,
  ignoreGitignore?: boolean,
): SourcePathDecision {
  return requireNative().sourcePathDecision(path, root, directory, ignoreGitignore);
}

export async function readSourceFiles(projectRoot: string): Promise<SourceTextFile[]> {
  return requireNative().readRepoFiles(projectRoot);
}

export interface CollectResult {
  files: SourceFile[];
  /** Recorded decisions to keep paths out, so absence is never unexplained. */
  exclusions: SourceExclusion[];
  exclusionSummary: ExclusionCount[];
  /** Anything the caller should be told about the input policy. */
  diagnostic: string | null;
  /**
   * False only when the gitignore matcher was abandoned entirely. A malformed
   * rule leaves the rest applied, which is a warning, not a relaxation.
   */
  gitignoreApplied: boolean;
  engine: "native";
  walkMs: number;
  parseMs: number;
}

export async function collectFiles(projectRoot: string): Promise<CollectResult> {
  const result = await requireNative().scanRepo(projectRoot);
  return {
    engine: "native",
    walkMs: result.walkMs,
    parseMs: result.parseMs,
    exclusions: result.exclusions,
    exclusionSummary: result.exclusionSummary,
    diagnostic: result.diagnostic ?? null,
    gitignoreApplied: result.gitignoreApplied,
    files: result.files.map((file) => ({
      path: file.path,
      lang: file.lang as SourceLanguage,
      loc: file.loc,
      bytes: file.bytes,
      contentSha: file.contentSha,
      isTest: file.isTest,
      parseable: file.parsed,
      statKey: file.statKey ?? null,
      parsed: file.parsed
        ? {
            symbols: file.symbols as ParsedSymbol[],
            imports: file.imports,
            executionEntries: file.executionEntries,
            syntaxSha: file.syntaxSha,
            relationSetSha: file.relationSetSha,
          }
        : null,
      refs: file.parsed ? file.refs : [],
    })),
  };
}
