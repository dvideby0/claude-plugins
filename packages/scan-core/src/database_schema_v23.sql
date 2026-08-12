-- The repository inventory is a policy decision, not just a file list.
--
-- Packaging output was entering the source map with nothing to explain it: a
-- file that never appeared looked exactly like a file that was never there.
-- Persisting the decisions the walk actually made is what lets the application
-- answer "why is this path absent" instead of leaving it unexplained.
--
-- A pruned directory is recorded once and its contents are never enumerated,
-- which is what keeps this bounded — not a cap doing the work after the fact.
CREATE TABLE IF NOT EXISTS excluded_paths (
  path      TEXT PRIMARY KEY,
  -- 1 when the walk stopped at this directory rather than descending.
  directory INTEGER NOT NULL DEFAULT 0,
  -- Stable machine key from the input policy's closed reason set.
  reason    TEXT NOT NULL,
  -- Which rule matched, phrased for a person: a directory name, a .gitignore
  -- pattern, a size comparison, or an OS error.
  detail    TEXT NOT NULL DEFAULT '',
  run_id    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_excluded_paths_reason ON excluded_paths(reason);

-- Recorded rows are capped and the highest-volume reason is never listed per
-- path, so `paths` carries the true count for every reason. A bounded sample
-- must never be presented as the whole answer.
CREATE TABLE IF NOT EXISTS exclusion_summary (
  reason   TEXT PRIMARY KEY,
  paths    INTEGER NOT NULL,
  recorded INTEGER NOT NULL,
  run_id   INTEGER NOT NULL
);
