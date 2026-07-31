export const SCHEMA_VERSION = 1;

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
  end_line   INTEGER NOT NULL,
  exported   INTEGER NOT NULL DEFAULT 0,
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
`;
