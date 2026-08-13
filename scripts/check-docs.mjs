#!/usr/bin/env node
/**
 * Documentation structure gate.
 *
 * The docs are a hub-and-leaf tree that nothing but discipline keeps honest:
 * a fact has one canonical home, every page is reachable from a hub, and the
 * catalogs that mirror generated inventories must agree with their source.
 * This checks the parts a person cannot reliably check by hand.
 *
 * Placement rules live in docs/README.md. This file enforces them.
 *
 * Every check asserts it saw input before it reports success — a check that
 * could not run is a gap, not a pass, and that applies to this file first.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Shipped assets that happen to be markdown. Their links are checked; the
 *  hub-and-breadcrumb rules do not apply to them. */
const NOT_DOCS = ["plugins/sdlc/commands/", "packages/engine/content/"];

/** Entry points. A harness loads these by name, so nothing needs to link them. */
const ROOT_PAGES = ["README.md", "AGENTS.md", "CLAUDE.md"];

const SERVER = "packages/engine/src/mcp/server.ts";
const TOOL_CATALOG = "docs/reference/mcp-tools.md";
const COMMAND_CATALOG = "docs/reference/plugin-commands.md";
const COMMAND_DIR = "plugins/sdlc/commands";

const failures = [];
const fail = (file, message) => failures.push({ file, message });

/** A precondition this file cannot check around. Reported, never thrown past. */
const broken = [];
const cannotRun = (what, detail) => broken.push(`${what}: ${detail}`);

const isNotDocs = (p) => NOT_DOCS.some((prefix) => p.startsWith(prefix));
const read = (p) => readFileSync(join(repo, p), "utf8");

function tracked(pattern) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", pattern],
      { cwd: repo, encoding: "utf8" },
    );
  } catch (error) {
    cannotRun("git ls-files", `${error.message}. Run this inside a git checkout.`);
    return [];
  }
  return [...new Set(out.split("\n").filter(Boolean))];
}

/**
 * Fenced code is sample text, not structure. A `#` in a bash block is not a
 * heading, and a link in a markdown sample is not a link this repo owns.
 * Blanking the lines preserves numbering for error messages.
 */
function withoutFences(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const open = /^\s*(```+|~~~+)/.exec(line);
      if (fence) {
        if (open && line.trim().startsWith(fence)) fence = null;
        return "";
      }
      if (open) {
        fence = open[1];
        return "";
      }
      return line;
    })
    .join("\n");
}

/**
 * Inline code is sample text too — `df[col][row]` is not a reference link.
 * Blanked rather than removed so offsets and line numbers stay true.
 */
function withoutInlineCode(text) {
  return text.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (span) =>
    span.replace(/[^\n]/g, " "),
  );
}

// ------------------------------------------------------------------ inputs

const listedMarkdown = tracked("*.md");
/** Git lists a file it has been told about even after it leaves the disk. */
const allMarkdown = listedMarkdown.filter((p) => existsSync(join(repo, p)));
for (const p of listedMarkdown) {
  if (!allMarkdown.includes(p)) fail(p, "is tracked but missing from disk");
}
if (allMarkdown.length === 0) {
  cannotRun("markdown discovery", "found no tracked markdown files at all");
}
const docPages = allMarkdown.filter((p) => !isNotDocs(p));
if (docPages.length === 0 && allMarkdown.length > 0) {
  cannotRun("markdown discovery", "every markdown file was excluded as a shipped asset");
}

/** Case-exact membership. macOS would accept a wrong-case link that Linux CI rejects. */
const trackedSet = new Set(allMarkdown);

/**
 * Git still lists a file it has been told about but that is gone from disk, so
 * a page must be both spelled correctly and actually present.
 */
const hasFile = (p) => trackedSet.has(p);

const sources = [...tracked("*.ts"), ...tracked("*.rs"), ...tracked("*.mjs")].filter(
  (p) =>
    !p.includes("/dist/") && !p.endsWith("check-docs.mjs") && existsSync(join(repo, p)),
);
if (sources.length === 0) {
  cannotRun("source discovery", "found no .ts/.rs/.mjs files to scan for cited doc paths");
}

// ------------------------------------------------------------------ slugs

/**
 * GitHub's heading anchor: lowercase, drop everything that is not a word
 * character, space or hyphen, then replace each remaining space with a hyphen.
 * Removed punctuation therefore leaves a doubled hyphen — "P0 — foundations"
 * becomes "p0--foundations", not "p0-foundations".
 */
function slugify(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // a link in a heading renders as its text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}

const slugCache = new Map();
function slugsOf(page) {
  if (slugCache.has(page)) return slugCache.get(page);
  const seen = new Map();
  const set = new Set();
  for (const line of withoutFences(read(page)).split("\n")) {
    if (!/^#{1,6} /.test(line)) continue;
    const base = slugify(line.replace(/^#{1,6} /, ""));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n === 0 ? base : `${base}-${n}`);
  }
  slugCache.set(page, set);
  return set;
}

// ------------------------------------------------------------------ links

const INLINE = /\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const REF_DEF = /^\[([^\]]+)\]:[ \t]*(\S+)/gm;
const REF_USE = /\[(?:[^[\]]|\[[^\]]*\])*\]\[([^\]]*)\]/g;

/** Edges between pages, used for reachability. Includes shipped assets as sources. */
const outbound = new Map();
let linksChecked = 0;
let anchorsChecked = 0;

for (const page of allMarkdown) {
  const raw = read(page);
  const text = withoutInlineCode(withoutFences(raw));
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const skipped = new Set(
    raw
      .split("\n")
      .map((l, i) => (l.includes("<!-- planned -->") ? i + 1 : 0))
      .filter(Boolean),
  );

  const defs = new Map();
  for (const m of text.matchAll(REF_DEF)) defs.set(m[1].toLowerCase(), m[2]);

  const hrefs = [...text.matchAll(INLINE)].map((m) => ({ href: m[1], at: lineOf(m.index) }));
  for (const m of text.matchAll(REF_DEF)) hrefs.push({ href: m[2], at: lineOf(m.index) });

  for (const m of text.matchAll(REF_USE)) {
    const label = m[1].toLowerCase();
    if (label && !defs.has(label)) {
      fail(page, `line ${lineOf(m.index)}: reference link [${label}] has no definition`);
    }
  }

  for (const { href, at } of hrefs) {
    if (skipped.has(at)) continue;
    if (/^(https?:|mailto:|#)/.test(href)) continue;

    const hash = href.indexOf("#");
    const rawPath = hash === -1 ? href : href.slice(0, hash);
    const anchor = hash === -1 ? "" : href.slice(hash + 1);
    if (!rawPath) continue;

    const target = posix.normalize(posix.join(posix.dirname(page), rawPath));
    linksChecked++;

    const isDir = !target.endsWith(".md");
    const exists = isDir ? existsSync(join(repo, target)) : hasFile(target);
    if (!exists) {
      fail(page, `line ${at}: link to missing "${href}"`);
      continue;
    }

    if (!outbound.has(page)) outbound.set(page, new Set());
    outbound.get(page).add(target);

    if (anchor && hasFile(target)) {
      anchorsChecked++;
      if (!slugsOf(target).has(anchor)) {
        fail(page, `line ${at}: "${rawPath}" has no heading "#${anchor}"`);
      }
    }
  }
}

// ------------------------------------------------- doc paths named in code

let citationsChecked = 0;
for (const source of sources) {
  for (const [, cited] of read(source).matchAll(/\b(docs\/[A-Za-z0-9_/-]+\.md)\b/g)) {
    citationsChecked++;
    if (!hasFile(cited)) {
      fail(source, `names a documentation path that does not exist: "${cited}"`);
    }
  }
}

// -------------------------------------------------------------- parity

/**
 * These two catalogs mirror generated inventories and are the reason this file
 * exists. Their absence is a gap, not a pass.
 */
let toolParity = "not run";
let commandParity = "not run";

if (!existsSync(join(repo, SERVER))) {
  cannotRun("tool parity", `${SERVER} not found. Update SERVER in this script if it moved.`);
} else if (!hasFile(TOOL_CATALOG)) {
  cannotRun("tool parity", `${TOOL_CATALOG} is missing. It is required, not optional.`);
} else {
  const serverText = read(SERVER);
  const registrations = (serverText.match(/server\.tool\(/g) ?? []).length;
  const names = [...serverText.matchAll(/server\.tool\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);

  if (registrations === 0) {
    cannotRun("tool parity", `found no server.tool( calls in ${SERVER}`);
  } else if (names.length !== registrations) {
    // Silently reading fewer names than registrations is how an undocumented
    // tool slips through: it is absent from both sides of the comparison.
    cannotRun(
      "tool parity",
      `${SERVER} has ${registrations} server.tool( calls but ${names.length} readable names. ` +
        `Either a registration changed shape or this script's pattern needs updating.`,
    );
  } else {
    const registered = new Set(names);
    const documented = new Set(
      [...read(TOOL_CATALOG).matchAll(/^\|\s*`([A-Za-z0-9_]+)`/gm)].map((m) => m[1]),
    );
    if (documented.size === 0) {
      cannotRun("tool parity", `read no tool rows from ${TOOL_CATALOG}`);
    } else {
      for (const name of registered) {
        if (!documented.has(name)) fail(TOOL_CATALOG, `\`${name}\` is registered but not documented`);
      }
      for (const name of documented) {
        if (!registered.has(name)) fail(TOOL_CATALOG, `\`${name}\` is documented but not registered`);
      }
      toolParity = `${registered.size} tools`;
    }
  }
}

if (!hasFile(COMMAND_CATALOG)) {
  cannotRun("command parity", `${COMMAND_CATALOG} is missing. It is required, not optional.`);
} else {
  const onDisk = new Set(
    tracked(`${COMMAND_DIR}/*.md`).map((p) => p.split("/").pop().replace(/\.md$/, "")),
  );
  const listed = new Set(
    [...read(COMMAND_CATALOG).matchAll(/commands\/([a-z0-9-]+)\.md/g)].map((m) => m[1]),
  );
  if (onDisk.size === 0) {
    cannotRun("command parity", `found no command files under ${COMMAND_DIR}/`);
  } else if (listed.size === 0) {
    cannotRun("command parity", `read no command links from ${COMMAND_CATALOG}`);
  } else {
    for (const name of onDisk) {
      if (!listed.has(name)) fail(COMMAND_CATALOG, `/${name} exists but is not in the catalog`);
    }
    for (const name of listed) {
      if (!onDisk.has(name)) fail(COMMAND_CATALOG, `/${name} is catalogued but has no command file`);
    }
    commandParity = `${onDisk.size} commands`;
  }
}

// -------------------------------------------------------- reachability

/**
 * "Linked from somewhere" is not the rule — two pages linking only to each
 * other satisfy that while being reachable from nothing. Walk from the entry
 * points instead.
 */
const reachable = new Set();
const queue = ROOT_PAGES.filter((p) => hasFile(p));
if (queue.length === 0) {
  cannotRun("reachability", `none of the entry points exist: ${ROOT_PAGES.join(", ")}`);
}
while (queue.length > 0) {
  const page = queue.shift();
  if (reachable.has(page)) continue;
  reachable.add(page);
  for (const next of outbound.get(page) ?? []) {
    if (hasFile(next) && !reachable.has(next)) queue.push(next);
  }
}

for (const page of docPages) {
  if (!reachable.has(page)) {
    fail(page, "is reachable from no hub — link it from a page that is, in the same change");
  }
}

// ----------------------------------------------------------- breadcrumbs

const BREADCRUMB_SHAPE =
  'expected line 1 "# Title", line 2 blank, line 3 "> [Parent](...) · [Grandparent](...)"';

for (const page of docPages) {
  if (ROOT_PAGES.includes(page)) continue;

  const lines = read(page).split("\n").map((l) => l.replace(/\r$/, ""));
  if (!lines[2]?.startsWith("> ")) {
    fail(page, `line 3 must be a breadcrumb — ${BREADCRUMB_SHAPE}`);
  } else if (!/\[[^\]]+\]\([^)]+\)/.test(lines[2])) {
    fail(page, `line 3 breadcrumb must link to its parent — ${BREADCRUMB_SHAPE}`);
  }
}

// ---------------------------------------------------------------- report

if (broken.length > 0) {
  console.error("\ncheck-docs: could not run — this is a gap, not a pass\n");
  for (const line of broken) console.error(`  ${line}`);
}

if (failures.length > 0) {
  console.error(`\ncheck-docs: ${failures.length} problem(s)\n`);
  for (const { file, message } of failures) console.error(`  ${file}: ${message}`);
}

if (broken.length > 0 || failures.length > 0) {
  console.error("\nPlacement and ownership rules: docs/README.md\n");
  process.exit(1);
}

console.log(
  `check-docs: ${docPages.length} pages, ${linksChecked} links, ${anchorsChecked} anchors, ` +
    `${citationsChecked} cited paths, tool parity ${toolParity}, command parity ${commandParity}, ` +
    `${reachable.size} pages reachable. No problems.`,
);
