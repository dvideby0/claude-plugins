/**
 * Symbol and import extraction via tree-sitter.
 *
 * Imports come from the syntax tree, never from prose — the dependency graph
 * is only as trustworthy as this step.
 */

import { extname } from "node:path";
import { loadTreeSitter, type GrammarName, type TsNode } from "../runtime/assets.js";
import type { Lang } from "./walk.js";

export interface ParsedSymbol {
  kind: "function" | "method" | "class" | "interface" | "type" | "enum" | "constant";
  name: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  /** This declaration is the module's default export, whatever its local name. */
  defaultExport: boolean;
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

// Truncation counts code points, matching the native parser's `chars()` —
// counting UTF-16 units here made the two produce different signatures for
// the same emoji-bearing declaration.
function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

function firstLine(node: TsNode, max = 160): string {
  return truncate(node.text.split("\n", 1)[0]?.trim() ?? "", max);
}

/** A constant's whole declaration on one line — the values are the point. */
function flattened(node: TsNode, max = 240): string {
  return truncate(node.text.split(/\s+/).join(" ").trim(), max);
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

/**
 * The nesting differs by declaration kind: a function_declaration's parent is
 * the export_statement, but `export const x = ...` goes declarator →
 * lexical_declaration → export_statement. A fixed depth got the second wrong.
 */
function isExportedTs(node: TsNode): boolean {
  let current: TsNode | null = node.parent;
  for (let depth = 0; depth < 3 && current; depth++) {
    if (current.type === "export_statement") return true;
    current = current.parent;
  }
  return false;
}

/** Local declaration names exported through the module's `default` slot. */
function defaultExportNames(exports: TsNode[]): Set<string> {
  const names = new Set<string>();

  const firstDeclaredName = (node: TsNode): string | null => {
    if (node.type === "identifier" && node.text) return node.text;
    const own = node.childForFieldName("name");
    if (own?.text) return own.text;
    for (const child of node.namedChildren) {
      const found = firstDeclaredName(child);
      if (found) return found;
    }
    return null;
  };

  const visitSpecifiers = (node: TsNode): void => {
    if (node.type === "export_specifier") {
      const local = node.childForFieldName("name")?.text;
      const alias = node.childForFieldName("alias")?.text;
      if (local && alias === "default") names.add(local);
      return;
    }
    for (const child of node.namedChildren) visitSpecifiers(child);
  };

  for (const node of exports) {
    if (node.text.trimStart().startsWith("export default")) {
      const declaration = node.childForFieldName("declaration");
      const value = node.childForFieldName("value");
      const name = declaration ? firstDeclaredName(declaration) : firstDeclaredName(value ?? node);
      if (name) names.add(name);
    }
    visitSpecifiers(node);
  }
  return names;
}

function pythonKind(node: TsNode): "function" | "method" {
  // A decorated method nests one level deeper: function_definition →
  // decorated_definition → block → class_definition.
  const anchor = node.parent?.type === "decorated_definition" ? node.parent : node;
  return anchor.parent?.parent?.type === "class_definition" ? "method" : "function";
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

  const captures = (query as { captures(n: TsNode): Array<{ name: string; node: TsNode }> }).captures(
    tree.rootNode,
  );
  const defaults =
    grammar === "python"
      ? new Set<string>()
      : defaultExportNames(
          captures.filter((capture) => capture.name === "export").map(({ node }) => node),
        );

  for (const capture of captures) {
    const { name: label, node } = capture;

    if (label === "import" || label === "export") {
      const source_ = node.childForFieldName("source");
      if (source_) imports.add(stripQuotes(source_.text));
      // Python `import a, b as c` — every comma-separated module, not just
      // the first: `childForFieldName` only ever returns one node.
      if (grammar === "python" && label === "import") {
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name") {
            imports.add(child.text.trim());
          } else if (child.type === "aliased_import") {
            const target = child.childForFieldName("name");
            if (target) imports.add(target.text.trim());
          }
        }
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
      const value = node.childForFieldName("value");
      const valueType = value?.type ?? "";
      const callable = /^(arrow_function|function_expression|function|class)$/.test(valueType);
      const defaultExport = defaults.has(name);
      const exported = isExportedTs(node) || defaultExport;

      // Exported constants are the codebase's vocabulary — the closed sets of
      // allowed values — so they are recorded even though they are data.
      if (!callable && !exported) continue;

      symbols.push({
        kind: callable ? (valueType === "class" ? "class" : "function") : "constant",
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        exported,
        defaultExport,
        signature: callable ? firstLine(node) : flattened(node),
      });
      continue;
    }

    const kind =
      label === "function" && grammar === "python"
        ? pythonKind(node)
        : (label as ParsedSymbol["kind"]);

    const defaultExport = grammar !== "python" && defaults.has(name);
    symbols.push({
      kind,
      name,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: grammar === "python" ? !name.startsWith("_") : isExportedTs(node) || defaultExport,
      defaultExport,
      signature: firstLine(node),
    });
  }

  return { symbols, imports: [...imports] };
}
