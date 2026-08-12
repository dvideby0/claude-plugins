-- Findings are historical evidence. Persist the indexed source revision that
-- produced each range so a later watch scan cannot make an old location look
-- current merely because the file inventory itself has advanced.
ALTER TABLE findings
  ADD COLUMN content_sha TEXT;
