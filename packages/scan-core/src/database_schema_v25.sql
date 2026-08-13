-- Record how each file's facts were established, not only what they are.
--
-- Every scan re-reads and re-hashes every file, so a warm rescan of an
-- untouched repository costs the same as a cold one. Skipping the unchanged
-- ones needs somewhere to keep the filesystem's identity for a file between
-- scans, and — more importantly — somewhere to say whether a given row was
-- established by reading the bytes or by trusting that identity.
--
-- The second part is the one that matters. A tool that could not run is a gap,
-- not a pass, and by the same rule a file nobody read is not a file confirmed
-- unchanged. Storing the basis keeps those two distinguishable in the store
-- itself rather than in whatever the last caller happened to believe.
--
-- All three are nullable and every one of them is self-healing. A store
-- migrated from v24 has NULL everywhere, NULL is never read as "unchanged",
-- and the next ordinary scan fills them in. That is why this needs no
-- `EXTRACTION_VERSION` bump: unlike a parser-produced column, an absent value
-- here cannot produce a wrong answer, only an unnecessary read.

-- The filesystem's identity for the file as of the scan that read it: device,
-- inode, size, modification and change times, folded into one digest and
-- compared for equality only. NULL means this observation cannot serve as a
-- baseline — the file was still inside the racy window when it was seen, or
-- the platform has no trustworthy fields — so the next scan must read it.
ALTER TABLE files ADD COLUMN stat_key TEXT;

-- How this row's facts were established: 'read' when the bytes were read and
-- hashed, 'verified' when the filesystem identity matched and the read was
-- skipped, 'sampled' when a skippable file was read anyway to check the key
-- still tells the truth. NULL predates the distinction.
ALTER TABLE files ADD COLUMN freshness_basis TEXT;

-- The run that last actually read this file. With `last_seen_run` beside it,
-- a person can be told "established at run 41, confirmed unchanged at run 57"
-- without either a timestamp column or a guess.
ALTER TABLE files ADD COLUMN last_read_run INTEGER;
