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
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Shipped assets that happen to be markdown. They are not documentation. */
const NOT_DOCS = ["plugins/sdlc/commands/", "packages/engine/content/"];

/** Entry points. A harness loads these by name, so nothing needs to link them. */
const ROOT_PAGES = ["README.md", "AGENTS.md", "CLAUDE.md"];

const failures = [];
const fail = (file, message) => failures.push({ file, message });

const isNotDocs = (p) => NOT_DOCS.some((prefix) => p.startsWith(prefix));
const read = (p) => readFileSync(join(repo, p), "utf8");

/**
 * Tracked files plus new ones git would accept. A doc added in this change must
 * be checked in this change — waiting for the commit is how an orphan ships.
 */
function tracked(pattern) {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", pattern],
    { cwd: repo, encoding: "utf8" },
  );
  return [...new Set(out.split("\n").filter(Boolean))];
}

/**
 * A tool that could not run is a gap, not a pass. Every extraction below feeds
 * an equality assertion, so returning nothing would silently report success.
 */
function extractAll(text, regex, what, source) {
  const found = [...text.matchAll(regex)].map((m) => m[1]);
  if (found.length === 0) {
    throw new Error(
      `Extracted no ${what} from ${source}. Either that file changed shape or ` +
        `this checker's pattern needs updating — this is not a pass.`,
    );
  }
  return found;
}

const markdown = tracked("*.md");
const docPages = markdown.filter((p) => !isNotDocs(p));

// ---------------------------------------------------------------- 1. links

/** GitHub-style heading slug, enough for the anchors we actually write. */
function slugs(text) {
  return new Set(
    text
      .split("\n")
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) =>
        l
          .replace(/^#{1,6} /, "")
          .trim()
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-"),
      ),
  );
}

const linkTargets = new Set();
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

for (const page of docPages) {
  const text = read(page);
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    // A row may point at a page a later phase writes. Marked, not silent.
    if (line.includes("<!-- planned -->")) return;

    for (const [, href] of line.matchAll(LINK)) {
      if (/^(https?:|mailto:|#)/.test(href)) continue;

      const [rawPath, anchor] = href.split("#");
      if (!rawPath) continue;

      const target = posix.normalize(posix.join(posix.dirname(page), rawPath));
      const absolute = join(repo, target);

      if (!existsSync(absolute)) {
        fail(page, `line ${i + 1}: link to missing "${href}"`);
        continue;
      }

      linkTargets.add(target.replace(/\/$/, ""));

      if (anchor && target.endsWith(".md") && !slugs(read(target)).has(anchor)) {
        fail(page, `line ${i + 1}: "${rawPath}" has no heading "#${anchor}"`);
      }
    }
  });
}

// ------------------------------------------------- 2. doc paths named in code

for (const source of [...tracked("*.ts"), ...tracked("*.rs"), ...tracked("*.mjs")]) {
  if (source.includes("/dist/") || source.endsWith("check-docs.mjs")) continue;

  const text = read(source);
  for (const [, cited] of text.matchAll(/\b(docs\/[A-Za-z0-9_/-]+\.md)\b/g)) {
    if (!existsSync(join(repo, cited))) {
      fail(source, `code comment cites missing "${cited}"`);
    }
  }
}

// -------------------------------------------------------------- 3. parity

const serverPath = "packages/engine/src/mcp/server.ts";
const catalogPath = "docs/reference/mcp-tools.md";
const commandCatalog = "docs/reference/plugin-commands.md";

if (existsSync(join(repo, catalogPath))) {
  const registered = new Set(
    extractAll(
      read(serverPath),
      /server\.tool\(\s*\n\s*"([a-z_]+)"/g,
      "tool registrations",
      serverPath,
    ),
  );
  const documented = new Set(
    extractAll(read(catalogPath), /^\|\s*`([a-z_]+)`/gm, "tool rows", catalogPath),
  );

  for (const name of registered) {
    if (!documented.has(name)) fail(catalogPath, `\`${name}\` is registered but not documented`);
  }
  for (const name of documented) {
    if (!registered.has(name)) fail(catalogPath, `\`${name}\` is documented but not registered`);
  }
}

if (existsSync(join(repo, commandCatalog))) {
  const onDisk = new Set(
    tracked("plugins/sdlc/commands/*.md").map((p) => p.split("/").pop().replace(/\.md$/, "")),
  );
  if (onDisk.size === 0) {
    throw new Error("Found no plugin command files — this is not a pass.");
  }
  const listed = new Set(
    extractAll(
      read(commandCatalog),
      /commands\/([a-z-]+)\.md/g,
      "command links",
      commandCatalog,
    ),
  );

  for (const name of onDisk) {
    if (!listed.has(name)) fail(commandCatalog, `/${name} exists but is not in the catalog`);
  }
  for (const name of listed) {
    if (!onDisk.has(name)) fail(commandCatalog, `/${name} is catalogued but has no command file`);
  }
}

// -------------------------------------------------------------- 4. orphans

for (const page of docPages) {
  if (ROOT_PAGES.includes(page)) continue;
  if (!linkTargets.has(page)) {
    fail(page, "is linked from no other page — add it to a hub in the same change");
  }
}

// ----------------------------------------------------------- 5. breadcrumbs

for (const page of docPages) {
  if (ROOT_PAGES.includes(page)) continue;

  const lines = read(page).split("\n");
  if (!lines[2]?.startsWith("> ")) {
    fail(page, "line 3 must be a `> ` breadcrumb naming its parent");
  }
}

// ---------------------------------------------------------------- report

if (failures.length > 0) {
  console.error(`\ncheck-docs: ${failures.length} problem(s)\n`);
  for (const { file, message } of failures) console.error(`  ${file}: ${message}`);
  console.error("\nPlacement and ownership rules: docs/README.md\n");
  process.exit(1);
}

console.log(`check-docs: ${docPages.length} pages, no problems.`);
