-- Import edges are evidence-backed facts. Preserve the exact source statement
-- so task context and the desktop navigate to the import instead of an
-- arbitrary prefix of the importing file. Existing rows are populated by the
-- extraction-version rebuild on the next scan.
ALTER TABLE edges
  ADD COLUMN start_line INTEGER;
ALTER TABLE edges
  ADD COLUMN end_line INTEGER;
