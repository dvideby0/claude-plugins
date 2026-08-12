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
  imports: string[];
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
  parsed: ParsedSource | null;
  refs: SourceRef[];
}

export interface SourceTextFile {
  path: string;
  lang: SourceLanguage;
  contentSha: string;
  isTest: boolean;
  content: string;
}

export interface SourcePathPolicy {
  language: SourceLanguage;
  ignored: boolean;
  noise: boolean;
}

interface NativeFile {
  path: string;
  lang: string;
  loc: number;
  bytes: number;
  contentSha: string;
  isTest: boolean;
  parsed: boolean;
  symbols: Array<{
    kind: string;
    name: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    exported: boolean;
    defaultExport: boolean;
    signature: string;
  }>;
  imports: string[];
  refs: Array<{ name: string; module: string; line: number; column: number }>;
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
  scanRepo(root: string): Promise<{ files: NativeFile[]; walkMs: number; parseMs: number }>;
  /** Read source text through the same bounded inventory policy used by scans. */
  readRepoFiles(root: string): Promise<SourceTextFile[]>;
  /** Classify watcher paths through the Rust-owned repository policy. */
  sourcePathPolicy(path: string): SourcePathPolicy;
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
      typeof candidate.sourcePathPolicy !== "function"
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

export function sourcePathPolicy(path: string): SourcePathPolicy {
  return requireNative().sourcePathPolicy(path);
}

export async function readSourceFiles(projectRoot: string): Promise<SourceTextFile[]> {
  return requireNative().readRepoFiles(projectRoot);
}

export interface CollectResult {
  files: SourceFile[];
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
    files: result.files.map((file) => ({
      path: file.path,
      lang: file.lang as SourceLanguage,
      loc: file.loc,
      bytes: file.bytes,
      contentSha: file.contentSha,
      isTest: file.isTest,
      parsed: file.parsed
        ? { symbols: file.symbols as ParsedSymbol[], imports: file.imports }
        : null,
      refs: file.parsed ? file.refs : [],
    })),
  };
}
