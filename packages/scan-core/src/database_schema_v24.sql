-- Separate a change in meaning from a change in bytes.
--
-- Every artifact anchored to a file compared content hashes, so adding a
-- comment drifted its components, staled its flow steps, relations, memories
-- and explorations, and marked its execution entries out of date. Re-drawing a
-- map costs real money, and paying that for a typo trains people to ignore
-- staleness altogether.
--
-- Each artifact keeps its `content_sha`: that is still the right key for
-- anything anchored to a line range, because inserting a comment genuinely
-- moves those lines. The new `syntax_sha` beside it answers the different
-- question of whether the code itself changed.
--
-- These columns are parser-produced, so a migration can add them but cannot
-- fill them. `EXTRACTION_VERSION` is bumped in the same change, which promotes
-- the next scan of an existing workspace to a full one.

ALTER TABLE files ADD COLUMN syntax_sha TEXT;
ALTER TABLE files ADD COLUMN relation_set_sha TEXT;
-- Set when a file left this path as part of a correlated move, so authored
-- knowledge that followed it can be traced back.
ALTER TABLE files ADD COLUMN moved_to TEXT;

-- `symbols.id` embeds the declaration's line and column, so it changes when
-- anything above it moves and cannot be compared across scans. `symbol_key`
-- can.
ALTER TABLE symbols ADD COLUMN symbol_key TEXT;
ALTER TABLE symbols ADD COLUMN interface_sha TEXT;
ALTER TABLE symbols ADD COLUMN body_sha TEXT;
CREATE INDEX IF NOT EXISTS idx_symbols_key ON symbols(path, symbol_key);

ALTER TABLE execution_entries ADD COLUMN syntax_sha TEXT;

ALTER TABLE component_snapshot ADD COLUMN syntax_sha TEXT;
ALTER TABLE flow_steps ADD COLUMN syntax_sha TEXT;
ALTER TABLE relations ADD COLUMN syntax_sha TEXT;
ALTER TABLE memory_anchors ADD COLUMN syntax_sha TEXT;
ALTER TABLE explorations ADD COLUMN syntax_sha TEXT;

-- Drift for a whole box, computed from what its members mean rather than what
-- bytes they contain.
ALTER TABLE components ADD COLUMN member_syntax_digest TEXT;

-- What produced an interpretation. Human-authored components leave these null;
-- a generator that fills them lets a prompt or model change invalidate its own
-- output without touching the code. The producer belongs to SEM-001; the
-- storage is here so a signature has somewhere to go.
ALTER TABLE components ADD COLUMN generator_id TEXT;
ALTER TABLE components ADD COLUMN generator_version TEXT;
ALTER TABLE components ADD COLUMN model_id TEXT;
ALTER TABLE components ADD COLUMN prompt_sha TEXT;
ALTER TABLE components ADD COLUMN result_sha TEXT;

-- What a derived artifact was computed from.
--
-- One general mechanism rather than a column per relationship: the first row
-- whose recorded signature no longer matches the current one is both the
-- invalidation trigger and the sentence explaining it. `signature_kind` is open
-- so prompt and model dependencies record the same way source ones do.
CREATE TABLE IF NOT EXISTS artifact_dependencies (
  artifact_kind  TEXT NOT NULL,   -- component | flow | execution-entry
  artifact_id    TEXT NOT NULL,
  signature_kind TEXT NOT NULL,   -- file-content | file-syntax | symbol-interface | prompt | model
  depends_on     TEXT NOT NULL,   -- a path, a symbol key, or a producer id
  signature      TEXT NOT NULL,   -- the value observed when the artifact was produced
  run_id         INTEGER,
  PRIMARY KEY (artifact_kind, artifact_id, signature_kind, depends_on)
);

CREATE INDEX IF NOT EXISTS idx_artifact_dependencies_target
  ON artifact_dependencies(signature_kind, depends_on);

-- Correlated renames, kept as an audit trail.
--
-- Re-anchoring human knowledge onto the wrong code is the failure this has to
-- be answerable for, so every move records what evidence justified it.
CREATE TABLE IF NOT EXISTS file_moves (
  run_id    INTEGER NOT NULL,
  from_path TEXT NOT NULL,
  to_path   TEXT NOT NULL,
  evidence  TEXT NOT NULL,   -- git-rename | identical-content
  moved_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, from_path)
);
