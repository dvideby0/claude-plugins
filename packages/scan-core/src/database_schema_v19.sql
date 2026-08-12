-- Immutable schema v19. Deterministic execution facts are distinct from the
-- agent-authored `flows`/`flow_steps` overlay. The tables below are a bounded
-- framework-adapter graph owned and replaced per source file.
CREATE TABLE IF NOT EXISTS execution_entries (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  label            TEXT NOT NULL,
  method           TEXT NOT NULL DEFAULT '',
  route            TEXT NOT NULL DEFAULT '',
  path             TEXT NOT NULL,
  symbol           TEXT NOT NULL DEFAULT '',
  start_line       INTEGER NOT NULL,
  end_line         INTEGER NOT NULL,
  producer_id      TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  producer_kind    TEXT NOT NULL,
  certainty        TEXT NOT NULL,
  input_sha        TEXT NOT NULL,
  indexed_run      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_entries_path
  ON execution_entries(path, start_line);
CREATE INDEX IF NOT EXISTS idx_execution_entries_route
  ON execution_entries(kind, method, route);

CREATE TABLE IF NOT EXISTS execution_nodes (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES execution_entries(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  label         TEXT NOT NULL,
  path          TEXT NOT NULL,
  symbol        TEXT NOT NULL DEFAULT '',
  target_path   TEXT,
  target_symbol TEXT NOT NULL DEFAULT '',
  external      TEXT NOT NULL DEFAULT '',
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  certainty     TEXT NOT NULL,
  terminal      INTEGER NOT NULL DEFAULT 0,
  detail        TEXT NOT NULL DEFAULT '',
  UNIQUE(entry_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_execution_nodes_entry
  ON execution_nodes(entry_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_execution_nodes_target
  ON execution_nodes(target_path, target_symbol);

CREATE TABLE IF NOT EXISTS execution_edges (
  entry_id   TEXT NOT NULL REFERENCES execution_entries(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  src_id     TEXT NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
  dst_id     TEXT NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  certainty  TEXT NOT NULL,
  PRIMARY KEY(entry_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_execution_edges_src
  ON execution_edges(entry_id, src_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_execution_edges_dst
  ON execution_edges(entry_id, dst_id, ordinal);

CREATE TABLE IF NOT EXISTS execution_diagnostics (
  entry_id TEXT NOT NULL REFERENCES execution_entries(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  message  TEXT NOT NULL,
  PRIMARY KEY(entry_id, ordinal)
);
