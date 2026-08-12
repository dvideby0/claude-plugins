-- Schema v20 preserves the source spelling and exact occurrence coordinate of
-- an execution call target. Resolved destination identity can then be refreshed
-- from either syntax or compiler references without guessing from aliases.
ALTER TABLE execution_nodes
  ADD COLUMN target_local TEXT NOT NULL DEFAULT '';
ALTER TABLE execution_nodes
  ADD COLUMN target_line INTEGER NOT NULL DEFAULT 0;
ALTER TABLE execution_nodes
  ADD COLUMN target_column INTEGER NOT NULL DEFAULT 0;

UPDATE execution_nodes SET target_local = target_symbol;
