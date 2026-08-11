export const SCHEMA_VERSION = 16;

/**
 * The audit store. Files, symbols and edges are the deterministic picture of
 * the codebase; findings are long-lived entities keyed by a stable fingerprint
 * so they survive edits, get re-anchored, and can be marked fixed or accepted.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  git_sha       TEXT,
  files_total   INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  path           TEXT PRIMARY KEY,
  lang           TEXT NOT NULL,
  loc            INTEGER NOT NULL DEFAULT 0,
  bytes          INTEGER NOT NULL DEFAULT 0,
  content_sha    TEXT NOT NULL,
  churn          INTEGER NOT NULL DEFAULT 0,
  is_test        INTEGER NOT NULL DEFAULT 0,
  parsed         INTEGER NOT NULL DEFAULT 0,
  -- none: symbols/imports only; import: native imported-name refs; typed:
  -- compiler-resolved refs. Zero counts are only meaningful above none.
  ref_coverage   TEXT NOT NULL DEFAULT 'none',
  -- Workspace generation in which this source's compiler refs were replaced.
  ref_generation TEXT,
  -- Deterministic source signature that actually produced those compiler refs.
  ref_source_signature TEXT,
  present        INTEGER NOT NULL DEFAULT 1,
  first_seen_run INTEGER,
  last_seen_run  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_lang ON files(lang);
CREATE INDEX IF NOT EXISTS idx_files_present ON files(present);

CREATE TABLE IF NOT EXISTS symbols (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL DEFAULT 0,
  end_line   INTEGER NOT NULL,
  end_column INTEGER NOT NULL DEFAULT 0,
  exported   INTEGER NOT NULL DEFAULT 0,
  default_export INTEGER NOT NULL DEFAULT 0,
  signature  TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS edges (
  src_path  TEXT NOT NULL,
  specifier TEXT NOT NULL,
  dst_path  TEXT,
  external  TEXT,
  PRIMARY KEY (src_path, specifier)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_path);
CREATE INDEX IF NOT EXISTS idx_edges_external ON edges(external);

-- Uses of an imported name, resolved to the file that defines it. This is what
-- turns "who imports this file" into "who calls this function": edges carry
-- module dependencies, refs carry symbol ones.
CREATE TABLE IF NOT EXISTS refs (
  src_path  TEXT NOT NULL,
  src_line  INTEGER NOT NULL,
  src_column INTEGER NOT NULL DEFAULT 0,
  src_end_column INTEGER,
  name      TEXT NOT NULL,
  specifier TEXT NOT NULL,
  dst_path  TEXT,
  -- The symbol the reference occurs *inside*. Without it a ref says where a
  -- call happens but not who makes it, and a call chain cannot be walked:
  -- imports tell you a file can see another, never that A calls B calls C.
  src_symbol TEXT,
  src_symbol_id TEXT,
  -- Typed references carry the declaration line, which distinguishes two
  -- methods with the same name in the same file.
  dst_line INTEGER,
  dst_column INTEGER,
  dst_end_line INTEGER,
  dst_end_column INTEGER,
  dst_symbol_id TEXT,
  PRIMARY KEY (src_path, src_line, src_column, name, specifier)
);
CREATE INDEX IF NOT EXISTS idx_refs_caller ON refs(src_path, src_symbol);
CREATE INDEX IF NOT EXISTS idx_refs_caller_id ON refs(src_symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_dst ON refs(dst_path, name);
CREATE INDEX IF NOT EXISTS idx_refs_dst_id ON refs(dst_symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_src ON refs(src_path);

CREATE TABLE IF NOT EXISTS findings (
  id             TEXT PRIMARY KEY,
  rule_id        TEXT NOT NULL,
  category       TEXT NOT NULL,
  severity       TEXT NOT NULL,
  confidence     TEXT NOT NULL,
  source         TEXT NOT NULL,
  path           TEXT,
  line_start     INTEGER,
  line_end       INTEGER,
  anchor_sha     TEXT,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  suggestion     TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  first_seen_run INTEGER,
  last_seen_run  INTEGER,
  fixed_in_run   INTEGER,
  occurrences    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_path ON findings(path);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);

CREATE TABLE IF NOT EXISTS suppressions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id  TEXT,
  rule_id     TEXT,
  path_prefix TEXT,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_runs (
  run_id   INTEGER NOT NULL,
  tool     TEXT NOT NULL,
  status   TEXT NOT NULL,
  detail   TEXT,
  findings INTEGER NOT NULL DEFAULT 0
);

-- The map a person would draw.
--
-- Everything above this point is the machine's map: files, symbols, edges.
-- It is correct and nearly unreadable — nobody explains a system by listing
-- its imports. What a person draws instead is a handful of named boxes, some
-- arrows with verbs on them, and notes about what matters.
--
-- These tables hold that drawing. They are authored, not derived: an agent
-- reads the deterministic graph, decides what the regions actually are, and
-- records the interpretation. The graph below stays as the evidence, so any
-- box can be expanded back into the real files it claims to cover.

-- A named region. Nestable, because a system is layers inside layers.
CREATE TABLE IF NOT EXISTS components (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'module',
  parent_id  TEXT,
  ordinal    INTEGER NOT NULL DEFAULT 0,
  -- Digest of the member files and their content hashes at the moment this box
  -- was drawn. When it stops matching, this box — and only this box — needs
  -- looking at again. The first drawing is expensive; a change is not.
  member_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_components_parent ON components(parent_id);

-- What is inside a box. A glob covers a directory without listing it.
-- What each box contained, file by file, at the moment it was drawn.
-- The aggregate digest answers "has this box moved"; this answers "which
-- files moved", which is the difference between redrawing a component and
-- knowing exactly what to re-read.
CREATE TABLE IF NOT EXISTS component_snapshot (
  component_id TEXT NOT NULL,
  path         TEXT NOT NULL,
  content_sha  TEXT NOT NULL,
  PRIMARY KEY (component_id, path)
);

CREATE TABLE IF NOT EXISTS component_members (
  component_id TEXT NOT NULL,
  pattern      TEXT NOT NULL,
  symbol       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (component_id, pattern, symbol)
);

-- Files intentionally left outside the authored map. This is independent of
-- component timestamps: moving a box or editing prose must not acknowledge a
-- newly added, still-unexplained file.
CREATE TABLE IF NOT EXISTS map_file_ack (
  path            TEXT PRIMARY KEY,
  acknowledged_at TEXT NOT NULL
);

-- A named path through the system, in the order it happens.
CREATE TABLE IF NOT EXISTS flows (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  trigger    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flow_steps (
  flow_id  TEXT NOT NULL,
  ordinal  INTEGER NOT NULL,
  label    TEXT NOT NULL,
  path     TEXT,
  symbol   TEXT,
  note     TEXT,
  -- The file as it was when this step was written.
  content_sha TEXT,
  PRIMARY KEY (flow_id, ordinal)
);

-- Cross-cutting labels: entrypoint, adapter, model-call, io, config.
-- A component groups by location; a tag groups by nature, and the two
-- deliberately cut across each other.
CREATE TABLE IF NOT EXISTS tags (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS node_tags (
  tag    TEXT NOT NULL,
  path   TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  note   TEXT,
  PRIMARY KEY (tag, path, symbol)
);
CREATE INDEX IF NOT EXISTS idx_node_tags_path ON node_tags(path);

-- Relationships a parser cannot see, discovered by reading the code.
--
-- A framework that registers handlers as data — graph.add_node("x", fn),
-- app.route("/y")(handler), a plugin registry — leaves no static call from the
-- wiring to the thing wired. The parse is still right; it simply cannot know.
-- An agent reads the file, works out the edge, and records it here with the
-- evidence that justified it, so the claim can be audited rather than trusted.
--
-- Kept apart from the refs table on purpose: parsed facts and asserted ones
-- should never be indistinguishable, and a stale assertion must be
-- identifiable as an assertion.
CREATE TABLE IF NOT EXISTS relations (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  src_path     TEXT NOT NULL,
  src_symbol   TEXT,
  dst_path     TEXT,
  dst_symbol   TEXT,
  label        TEXT,
  evidence     TEXT NOT NULL,
  evidence_line INTEGER,
  confidence   TEXT NOT NULL DEFAULT 'medium',
  source       TEXT NOT NULL DEFAULT 'agent',
  content_sha  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relations_src ON relations(src_path, src_symbol);
CREATE INDEX IF NOT EXISTS idx_relations_dst ON relations(dst_path, dst_symbol);

-- What has been looked at, so the loop knows where it has already been.
CREATE TABLE IF NOT EXISTS explorations (
  path        TEXT PRIMARY KEY,
  content_sha TEXT NOT NULL,
  found       INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  explored_at TEXT NOT NULL
);

-- What is known about this codebase beyond what a parser can see: why things
-- are the way they are, what to watch out for, what was already tried. This is
-- the part an agent cannot re-derive by reading the code.
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'agent',
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);

-- Where a memory applies. content_sha records the file as it was when the
-- memory was written, so a note about code that has since changed can be
-- flagged rather than trusted blindly.
CREATE TABLE IF NOT EXISTS memory_anchors (
  memory_id   TEXT NOT NULL,
  path        TEXT NOT NULL,
  symbol      TEXT NOT NULL DEFAULT '',
  content_sha TEXT,
  PRIMARY KEY (memory_id, path, symbol)
);
CREATE INDEX IF NOT EXISTS idx_anchors_path ON memory_anchors(path);

-- Model review passes the engine ran itself, so cost and outcome are visible.
CREATE TABLE IF NOT EXISTS review_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER,
  unit_id     TEXT NOT NULL,
  agent       TEXT NOT NULL,
  status      TEXT NOT NULL,
  detail      TEXT,
  proposed    INTEGER NOT NULL DEFAULT 0,
  confirmed   INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL
);
`;
