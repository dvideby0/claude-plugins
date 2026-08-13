# Conventions

Rules this codebase has actually been burned by. Each one exists because
something broke, and most are also recorded as memories so they surface through
`context` and `brief` without anyone having to read this file.

That duplication is deliberate: a file has to be found and trusted, and it goes
stale silently. The store is the primary; this is the readable summary.

## Never assume the root

A monorepo has no config at its root — each package carries its own, and any
root file is a base others extend. This assumption was made independently three
times and was wrong every time:

- `ts.findConfigFile` searches **upward**, so from a repository root it finds
  nothing at all.
- `runTsc` checked only `<root>/tsconfig.json` and reported
  `skipped: no tsconfig.json` on a TypeScript monorepo — the single
  highest-signal checker silently never ran.

Search the root first, then one level of `packages/`, `apps/`, `libs/`,
`services/`.

## A tool that could not run is a gap, not a pass

`skipped` and `failed` are distinct from `ok`, and neither may be presented as
a clean result. A finding source only closes findings under its own rule prefix
and only when it actually ran — a linter that was not installed never marks its
previous findings fixed.

The same applies to output that reaches a person: where nothing resolved a
symbol, say **"uses not tracked"**, never "unused". Reporting unknown as zero
is how someone deletes live code.

## Schema changes need a migration

`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
new column never appears on an existing store — and an index over that column
then fails at open time with `no such column`.

The Rust SQLite owner is authoritative. The v17 bootstrap in
`packages/scan-core/src/database_schema_v17.sql` is immutable. For a schema
change, increment `DATABASE_SCHEMA_VERSION` and add one explicit ordered delta
to `apply_migration`; fresh stores replay the same frozen steps as upgrades.
Never make an older migration reference a mutable current-schema declaration.

Every upgrade runs under `BEGIN IMMEDIATE`, records SQLite `user_version` plus
the migration ledger, and retains the latest validated standalone backup for
that target version before changing the store. A destructive migration needs
its own preservation and rollback test; do not hide it inside the legacy
v1-v16 convergence path.

## Repository inventory has one implementation

`packages/scan-core` owns walking, source classification, ignore policy,
hashing and Tree-sitter extraction. Watcher decisions and content analyzers
must call that Rust boundary rather than reproduce its path rules in
TypeScript. A missing platform binary is a broken installation, not a reason to
silently downgrade to a second scanner with different evidence coverage.

## Only the repository's own content decides what is source

Packaging output reached the map: `release/` was absent from the ignored list,
and a packaged copy of this very application appeared as an unexplained,
drifting file. The fix is not a directory name. A repository's committed
`.gitignore` already states which paths are output, so that file participates
in the inclusion policy — and nothing else does. `.ignore`,
`$GIT_DIR/info/exclude`, the global gitignore and ignore files above the
workspace root are per-user or per-clone, and letting them decide would mean
two people scanning the same commit see different repositories. **Determinism
is the rule, not "ignore files are untrustworthy."**

The matcher is owned in `input_policy.rs` rather than switched on in
`WalkBuilder`, because the crate drops entries before anything can explain
them. Every skip returns a reason, `excluded_paths` records it, and the
overview shows it. A pruned directory is one decision — never enumerate its
interior to produce a count.

`EntryKind` exists because `skip_dir` and `is_watch_ignored_path` disagreed
about hidden segments, and neither was wrong: a hidden *directory* is
configuration, a trailing `.mcp.json` is an indexed input. Pass what the caller
knows instead of keeping two functions that happen to agree.

## Invalidate on meaning, anchor on bytes

Every artifact compared content hashes, so adding a comment drifted the
components, flow steps, relations, memories and explorations touching that
file. Re-drawing a map costs model calls; paying that for a typo teaches people
to ignore staleness.

Anything describing what code **means** compares `syntax_sha`, which is the
comment-free token stream. Anything anchored to a **line range** — findings,
source slices — keeps comparing `content_sha`, because inserting a comment
really does move those lines. Reporting a stale line number as current is worse
than over-invalidating: it is silent.

Both are stored. `lib/freshness.ts` owns the comparison and the sentence
explaining it, because a bare `stale: true` does not tell anyone whether to
re-read a claim or rewrite it. A file with no parser, or a store written before
signatures existed, falls back to content and says so rather than reporting an
unverifiable `current`.

A changed contract does **not** re-parse its callers: their own text is
unchanged, so their facts would be rebuilt identically — and doing it destroys
their compiler-resolved references. What a moved contract invalidates is the
*summaries* written against it, through `artifact_dependencies`, computed at
read time. Read time matters: `search_components_au` has no `WHEN` guard, so
writing to `components` during a scan re-indexes every one of them.

## Record the vocabulary, not just the shape

Exported constants are a codebase's closed value sets, and they are what a
caller most often invents a member of. They are recorded as symbols of kind
`constant` with their **whole declaration flattened onto one line**, because
the values are the reason to record them at all — a union written across
several lines loses everything useful if only its first line is kept.

## Blast radius excludes the file itself

A file using its own helper is a real reference but not a consequence of
changing it for anyone else. `impact` and `brief` count external uses only;
intra-file uses are reported separately. Before this split, 81% of all
references were self-references and every blast-radius number was inflated —
one file reported 189 references when 5 came from elsewhere.

## Say what did not happen

Every summary states its own coverage. An audit that ran five of nine tools
says so. A finding in a test file says it may be a fixture. A memory written
against code that has since changed comes back flagged stale rather than
quietly believed.

## Errors should say what to do

`"The SDLC engine is not running. Open the SDLC desktop app to start it, then
retry — no need to restart this session."` is the standard: what happened, what
to do, and what is *not* required.

## Derived sets get one definition

"Which files are on the map" was written twice — membership matched every
present file, coverage counted only source. The same page then reported boxes
holding 166 files in a 151-file repository. Where two queries answer the same
question, name the predicate once and use it in both places.

The same rule applies to rolling counts up a tree: union the sets, never sum
the counts, unless the children are provably disjoint. Boxes are allowed to
overlap.

## A stat key is evidence of identity, not of content

The walk skips reading a file whose recorded filesystem identity still matches.
On Unix that is device, inode, size, modification and change times. Windows has
neither a `ctime` with the Unix meaning nor a stable file index, so its key is
weaker and leans harder on sampling — which is why the rule is written as "the
identity" and not as a field list. A field list gets read on the platform where
those fields do not exist, and that is how a doc comes to describe a key that
was never built.

It is a good trade and it is not a proof: `cp -p`, `rsync -a`, a restore from
backup and an editor's save-by-rename each preserve some of those fields while
replacing the bytes, which is why the key uses every one it can get rather than
the obvious size-and-mtime pair.

Three rules come with it, and none is optional. Record how a fact was
established, so a file nobody read stays distinguishable from a file confirmed
unchanged — "a tool that could not run is a gap, not a pass" applies to a file
nobody looked at too. Sample: read a bounded rotating slice of what you would
have skipped and check the key still agrees with the contents. And when it does
not, escalate rather than annotate — every other skip in that run rested on the
same assumption, so redo the run and say why it cost more.

The matching trap is on the other side. A file may be skipped only if nothing
*else* in the run has invalidated it. A caller whose reference target was just
deleted has to be re-parsed even though it did not change, and that is only
known after the walk has already skipped it. Anything discovered mid-run that
invalidates an untouched file needs a way to rebuild that file by name.

## A handler must be bound where the element actually is

`on()` scoped its query to the view. The drawer hangs off `<body>`, so every
button inside it was dead — including its own Close — while looking perfectly
correct in the source. When an element lives outside the usual root, pass the
root explicitly rather than relying on the default.

Nested clickable regions need `stopPropagation`: without it the outermost
handler runs last and wins, so clicking a child opens its parent.

## Never strip JSONC comments with a regex

A tsconfig paths key ends in slash-star and an include glob contains
star-slash. A regex pairs those as a comment and deletes everything between —
which is usually the aliases the parser existed to find, in a completely
ordinary Vite/Next config. `stripJsonComments` in `scan/resolve.ts` walks
characters and passes string literals through untouched. This bug bit twice
in one day: the doc comment explaining the fix contained the same glob and
terminated itself.

## Check exit codes, not just output

ruff exits 2 with an empty stdout when its config is broken; mypy's exit-2
messages carry no line numbers, so a line-oriented regex sees nothing; tsc's
config-level errors have no `file(line,col)` prefix. In each case "no parsed
findings" plus "nonzero exit" meant *the tool never ran* — and reporting it
"ok" closed every finding it had ever recorded. Empty output is only clean
when the exit code says so.

## The engine's event loop is the product

A synchronous native call blocks the daemon for the whole scan, during which
health pings time out and every consumer reads "not answering" as "not
running" — the bridge tells the user to start an engine that is already
working, and the desktop shell spawns a doomed duplicate. Long native work
goes through napi `AsyncTask`, never a plain `#[napi] fn`. Compiler-grade
typed resolution follows the same rule: program construction and AST walking
run in a worker thread, and only the short generation check plus database
transaction returns to the daemon event loop.

## Writes are synchronous inside a transaction

Native SQLite exposes one directly persisted connection per store to every
request. An `await` inside an open transaction lets unrelated writes join it —
and roll back with it.
`Db.transaction(fn)` takes a synchronous callback on purpose: read and parse
first, then write in one synchronous pass. Scans are additionally serialised
per store (`scan.ts`), because the watcher, the HTTP job and the MCP tool are
three independent doors into the same handle.

## electron-builder and npm workspaces do not mix unattended

Its "install production dependencies" pass prunes dev dependencies — in a
hoisted workspace that is the shared root `node_modules`, so it deletes its
own binaries mid-build and every other workspace's dev deps with them
(`npmRebuild: false` disables the pass). Its `extraResources.from` rejects
paths outside the app directory. And an asar archive is unreadable by the
engine, which runs as a plain Node child (`ELECTRON_RUN_AS_NODE`), so the app
ships unpacked. Rust build intermediates live outside the package
(`CARGO_TARGET_DIR`, set in `scan-core/build.mjs`) or they get bundled and
break codesigning.

TypeScript does not delete output for removed source files. The engine's
`prebuild` must clean its exact `dist` directory before compiling, or retired
runtime code remains in the packaged desktop even though it disappeared from
`src`.

## Working on this repository

```bash
npm run build && npm test -w @sdlc/engine
node scripts/smoke.mjs                    # end to end through the bridge
```

A schema change additionally needs a run against an **existing** store, not
just a fresh one. That is the case `CREATE TABLE IF NOT EXISTS` hides.
