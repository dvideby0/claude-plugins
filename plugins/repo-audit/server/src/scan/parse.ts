/**
 * Symbol and import extraction via tree-sitter.
 *
 * Imports come from the syntax tree, never from prose — the dependency graph
 * is only as trustworthy as this step.
 */

import { extname } from "node:path";
import { loadTreeSitter, type GrammarName, type TsNode } from "../runtime/vendor.js";
import type { Lang } from "./walk.js";

export interface ParsedSymbol {
  kind: "function" | "method" | "class" | "interface" | "type" | "enum";
  name: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  signature: string;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  imports: string[];
}

const TS_QUERY = `
(function_declaration) @function
(generator_function_declaration) @function
(class_declaration) @class
(method_definition) @method
(interface_declaration) @interface
(type_alias_declaration) @type
(enum_declaration) @enum
(variable_declarator) @variable
(import_statement) @import
(export_statement) @export
`;

const PY_QUERY = `
(function_definition) @function
(class_definition) @class
(import_statement) @import
(import_from_statement) @import_from
`;

const queryCache = new Map<string, unknown>();

export function grammarFor(path: string, lang: Lang): GrammarName | null {
  if (lang === "python") return "python";
  if (lang === "typescript" || lang === "javascript") {
    const ext = extname(path).toLowerCase();
    return ext === ".tsx" || ext === ".jsx" || lang === "javascript" ? "tsx" : "typescript";
  }
  return null;
}

function firstLine(node: TsNode, max = 160): string {
  const line = node.text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

function isExportedTs(node: TsNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "export_statement") return true;
  // `export const x = () => {}` nests declarator → declaration → export_statement
  return parent.parent?.parent?.type === "export_statement";
}

function pythonKind(node: TsNode): "function" | "method" {
  return node.parent?.parent?.type === "class_definition" ? "method" : "function";
}

/** Parse one file. Returns empty results for unsupported languages. */
export async function parseFile(
  path: string,
  lang: Lang,
  source: string,
): Promise<ParseResult> {
  const grammar = grammarFor(path, lang);
  if (!grammar) return { symbols: [], imports: [] };

  const ts = await loadTreeSitter();
  const language = ts.grammars[grammar];
  ts.parser.setLanguage(language);

  const tree = ts.parser.parse(source);
  if (!tree) return { symbols: [], imports: [] };

  const querySource = grammar === "python" ? PY_QUERY : TS_QUERY;
  const cacheKey = `${grammar}:${querySource.length}`;
  let query = queryCache.get(cacheKey);
  if (!query) {
    query = new ts.Query(language, querySource);
    queryCache.set(cacheKey, query);
  }

  const symbols: ParsedSymbol[] = [];
  const imports = new Set<string>();

  for (const capture of (query as { captures(n: TsNode): Array<{ name: string; node: TsNode }> }).captures(
    tree.rootNode,
  )) {
    const { name: label, node } = capture;

    if (label === "import" || label === "export") {
      const source_ = node.childForFieldName("source");
      if (source_) imports.add(stripQuotes(source_.text));
      // Python `import a, b`
      if (grammar === "python" && label === "import") {
        const target = node.childForFieldName("name");
        if (target) imports.add(target.text.split(/\s+as\s+/)[0].trim());
      }
      continue;
    }

    if (label === "import_from") {
      const module = node.childForFieldName("module_name");
      if (module) imports.add(module.text.trim());
      continue;
    }

    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;
    const name = nameNode.text;
    if (!name) continue;

    if (label === "variable") {
      // Only record consts bound to functions or classes; skip plain data.
      const value = node.childForFieldName("value");
      const valueType = value?.type ?? "";
      if (!/^(arrow_function|function_expression|function|class)$/.test(valueType)) continue;
      symbols.push({
        kind: valueType === "class" ? "class" : "function",
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        exported: isExportedTs(node),
        signature: firstLine(node),
      });
      continue;
    }

    const kind =
      label === "function" && grammar === "python"
        ? pythonKind(node)
        : (label as ParsedSymbol["kind"]);

    symbols.push({
      kind,
      name,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: grammar === "python" ? !name.startsWith("_") : isExportedTs(node),
      signature: firstLine(node),
    });
  }

  return { symbols, imports: [...imports] };
}
