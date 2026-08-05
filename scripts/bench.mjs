#!/usr/bin/env node

/**
 * Compare the TypeScript scan path against the native one.
 *
 * Read-only: both walk and parse in memory and write nothing, so this can be
 * pointed at a real repository without leaving anything behind. Speed is only
 * half the question — the two must also agree, so the same files, hashes,
 * symbols and imports are checked before any timing is believed.
 *
 *   node scripts/bench.mjs <repo> [maxFiles]
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseFile } from "../packages/engine/dist/scan/parse.js";
import { walk } from "../packages/engine/dist/scan/walk.js";

const require = createRequire(import.meta.url);

const root = process.argv[2];
const limit = Number(process.argv[3] ?? Infinity);
if (!root) {
  console.error("usage: node scripts/bench.mjs <repo> [maxFiles]");
  process.exit(1);
}

let native = null;
try {
  native = require("../packages/scan-core/index.js");
} catch (error) {
  console.error("native core unavailable:", error.message);
}

const PARSEABLE = new Set(["typescript", "javascript", "python"]);
const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const ms = (value) => `${value.toFixed(0)}ms`;

// --- typescript path -------------------------------------------------------

console.log(bold(`\nTypeScript path`));

let start = performance.now();
const walked = await walk(root);
const tsWalk = performance.now() - start;
console.log(`  walk   ${ms(tsWalk).padStart(8)}  ${walked.length} files`);

const targets = walked.filter((file) => PARSEABLE.has(file.lang)).slice(0, limit);
let bytes = 0;
for (const file of targets) bytes += Buffer.byteLength(file.content);

start = performance.now();
const tsResults = new Map();
let tsSymbols = 0;
let tsImports = 0;
for (const file of targets) {
  const result = await parseFile(file.path, file.lang, file.content);
  tsResults.set(file.path, result);
  tsSymbols += result.symbols.length;
  tsImports += result.imports.length;
}
const tsParse = performance.now() - start;
console.log(`  parse  ${ms(tsParse).padStart(8)}  ${targets.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`         ${tsSymbols} symbols, ${tsImports} imports`);
const tsTotal = tsWalk + tsParse;

// --- native path -----------------------------------------------------------

if (!native) process.exit(0);

console.log(bold(`\nNative path`));

// One warm-up: the first call pays for grammar setup on each worker thread.
await native.scanRepo(root);

start = performance.now();
const rust = await native.scanRepo(root);
const rustTotal = performance.now() - start;

const rustParsed = rust.files.filter((file) => file.parsed);
const rustSymbols = rustParsed.reduce((sum, file) => sum + file.symbols.length, 0);
const rustImports = rustParsed.reduce((sum, file) => sum + file.imports.length, 0);

console.log(`  walk   ${ms(rust.walkMs).padStart(8)}  ${rust.files.length} files`);
console.log(`  parse  ${ms(rust.parseMs).padStart(8)}  ${rustParsed.length} files`);
console.log(`         ${rustSymbols} symbols, ${rustImports} imports`);

// --- agreement -------------------------------------------------------------

console.log(bold(`\nAgreement`));

const tsByPath = new Map(walked.map((file) => [file.path, file]));
const rustByPath = new Map(rust.files.map((file) => [file.path, file]));

const onlyTs = [...tsByPath.keys()].filter((path) => !rustByPath.has(path));
const onlyRust = [...rustByPath.keys()].filter((path) => !tsByPath.has(path));

let hashMismatch = 0;
let locMismatch = 0;
for (const [path, file] of tsByPath) {
  const other = rustByPath.get(path);
  if (!other) continue;
  if (other.contentSha !== file.contentSha) hashMismatch++;
  if (other.loc !== file.loc) locMismatch++;
}

const show = (label, value, detail = "") =>
  console.log(`  ${label.padEnd(22)} ${value === 0 ? "\x1b[32m0\x1b[0m" : `\x1b[31m${value}\x1b[0m`} ${detail}`);

console.log(`  files                  ts ${walked.length} · native ${rust.files.length}`);
show("only in typescript", onlyTs.length, onlyTs.slice(0, 3).join(", "));
show("only in native", onlyRust.length, onlyRust.slice(0, 3).join(", "));
show("content hash differs", hashMismatch);
show("line count differs", locMismatch);

// Symbols and imports, per file, over the set both parsed.
let symbolDiff = 0;
let importDiff = 0;
const examples = [];
for (const [path, expected] of tsResults) {
  const other = rustByPath.get(path);
  if (!other?.parsed) continue;
  if (other.symbols.length !== expected.symbols.length) {
    symbolDiff++;
    if (examples.length < 3) {
      examples.push(`${path} (ts ${expected.symbols.length} vs native ${other.symbols.length})`);
    }
  }
  const mine = new Set(other.imports);
  if (expected.imports.length !== mine.size || expected.imports.some((i) => !mine.has(i))) {
    importDiff++;
  }
}
show("files w/ symbol diff", symbolDiff, examples[0] ?? "");
show("files w/ import diff", importDiff);

// --- verdict ---------------------------------------------------------------

console.log(bold(`\nSpeedup`));
const rate = (label, a, b) =>
  console.log(`  ${label.padEnd(8)} ${ms(a).padStart(8)} → ${ms(b).padStart(8)}   ${(a / b).toFixed(1)}×`);
rate("walk", tsWalk, rust.walkMs || 1);
rate("parse", tsParse, rust.parseMs || 1);
rate("total", tsTotal, rustTotal);
console.log("");
