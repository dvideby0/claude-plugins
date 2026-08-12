-- Immutable schema v18. Search is a derived access path over relational facts,
-- not a second source of truth. The ordinary table preserves provenance and
-- lifecycle filters; SQLite FTS5 supplies tokenization, prefix indexes,
-- snippets, and BM25 ranking.
CREATE TABLE IF NOT EXISTS search_documents (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',
  symbol     TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  UNIQUE (kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_search_documents_kind_active
  ON search_documents(kind, active);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  title,
  body,
  path,
  symbol,
  content = 'search_documents',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

-- External-content FTS indexes must be updated before the content row is
-- changed or removed. These are the trigger forms prescribed by SQLite.
CREATE TRIGGER IF NOT EXISTS search_documents_ai
AFTER INSERT ON search_documents BEGIN
  INSERT INTO knowledge_fts(rowid, title, body, path, symbol)
  VALUES (new.rowid, new.title, new.body, new.path, new.symbol);
END;

CREATE TRIGGER IF NOT EXISTS search_documents_ad
AFTER DELETE ON search_documents BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, path, symbol)
  VALUES ('delete', old.rowid, old.title, old.body, old.path, old.symbol);
END;

CREATE TRIGGER IF NOT EXISTS search_documents_au
AFTER UPDATE ON search_documents BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, path, symbol)
  VALUES ('delete', old.rowid, old.title, old.body, old.path, old.symbol);
  INSERT INTO knowledge_fts(rowid, title, body, path, symbol)
  VALUES (new.rowid, new.title, new.body, new.path, new.symbol);
END;

-- Backfill every current source before installing its maintenance triggers.
INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
SELECT
  'file:' || path,
  'file',
  path,
  path,
  lang || CASE WHEN is_test = 1 THEN ' test' ELSE ' source' END,
  path,
  '',
  present
FROM files;

INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
SELECT
  'symbol:' || id,
  'symbol',
  id,
  name,
  kind || ' ' || COALESCE(signature, '') ||
    CASE WHEN exported = 1 THEN ' exported' ELSE '' END,
  path,
  name,
  1
FROM symbols;

INSERT INTO search_documents(
  id, kind, source_id, title, body, path, symbol, active, updated_at
)
SELECT
  'memory:' || m.id,
  'memory',
  m.id,
  m.title,
  m.kind || ' ' || m.source || ' ' || m.body,
  COALESCE((
    SELECT group_concat(anchor_path, ' ')
    FROM (
      SELECT a.path AS anchor_path
      FROM memory_anchors a
      WHERE a.memory_id = m.id
      ORDER BY a.path, a.symbol
    )
  ), ''),
  COALESCE((
    SELECT group_concat(anchor_symbol, ' ')
    FROM (
      SELECT a.symbol AS anchor_symbol
      FROM memory_anchors a
      WHERE a.memory_id = m.id AND a.symbol != ''
      ORDER BY a.path, a.symbol
    )
  ), ''),
  CASE WHEN m.status = 'active' THEN 1 ELSE 0 END,
  m.updated_at
FROM memories m;

INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
SELECT
  'finding:' || id,
  'finding',
  id,
  title,
  rule_id || ' ' || category || ' ' || severity || ' ' || confidence || ' ' ||
    source || ' ' || description || ' ' || COALESCE(suggestion, ''),
  COALESCE(path, ''),
  '',
  CASE WHEN status IN ('open', 'regressed') THEN 1 ELSE 0 END
FROM findings;

INSERT INTO search_documents(
  id, kind, source_id, title, body, path, symbol, active, updated_at
)
SELECT
  'component:' || c.id,
  'component',
  c.id,
  c.name,
  c.kind || ' ' || c.summary || ' ' || COALESCE((
    SELECT group_concat(member_text, ' ')
    FROM (
      SELECT cm.pattern || ' ' || cm.symbol AS member_text
      FROM component_members cm
      WHERE cm.component_id = c.id
      ORDER BY cm.pattern, cm.symbol
    )
  ), ''),
  COALESCE((
    SELECT group_concat(member_path, ' ')
    FROM (
      SELECT cm.pattern AS member_path
      FROM component_members cm
      WHERE cm.component_id = c.id
      ORDER BY cm.pattern, cm.symbol
    )
  ), ''),
  '',
  1,
  c.updated_at
FROM components c;

INSERT INTO search_documents(
  id, kind, source_id, title, body, path, symbol, active, updated_at
)
SELECT
  'flow:' || f.id,
  'flow',
  f.id,
  f.name,
  f.summary || ' ' || COALESCE(f.trigger, '') || ' ' || COALESCE((
    SELECT group_concat(step_text, ' ')
    FROM (
      SELECT fs.label || ' ' || COALESCE(fs.note, '') AS step_text
      FROM flow_steps fs
      WHERE fs.flow_id = f.id
      ORDER BY fs.ordinal
    )
  ), ''),
  COALESCE((
    SELECT group_concat(step_path, ' ')
    FROM (
      SELECT fs.path AS step_path
      FROM flow_steps fs
      WHERE fs.flow_id = f.id AND fs.path IS NOT NULL
      ORDER BY fs.ordinal
    )
  ), ''),
  COALESCE((
    SELECT group_concat(step_symbol, ' ')
    FROM (
      SELECT fs.symbol AS step_symbol
      FROM flow_steps fs
      WHERE fs.flow_id = f.id AND fs.symbol IS NOT NULL
      ORDER BY fs.ordinal
    )
  ), ''),
  1,
  f.updated_at
FROM flows f;

INSERT INTO search_documents(
  id, kind, source_id, title, body, path, symbol, active, updated_at
)
SELECT
  'relation:' || id,
  'relation',
  id,
  COALESCE(label, kind),
  kind || ' ' || evidence || ' ' || confidence || ' ' || source,
  src_path || ' ' || COALESCE(dst_path, ''),
  COALESCE(src_symbol, '') || ' ' || COALESCE(dst_symbol, ''),
  1,
  updated_at
FROM relations;

-- Files and declarations are deterministic facts maintained by scans.
CREATE TRIGGER IF NOT EXISTS search_files_ai
AFTER INSERT ON files BEGIN
  DELETE FROM search_documents WHERE id = 'file:' || new.path;
  INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
  VALUES (
    'file:' || new.path,
    'file',
    new.path,
    new.path,
    new.lang || CASE WHEN new.is_test = 1 THEN ' test' ELSE ' source' END,
    new.path,
    '',
    new.present
  );
END;

CREATE TRIGGER IF NOT EXISTS search_files_au
AFTER UPDATE ON files
WHEN old.path IS NOT new.path
  OR old.lang IS NOT new.lang
  OR old.is_test IS NOT new.is_test
  OR old.present IS NOT new.present
BEGIN
  DELETE FROM search_documents WHERE id = 'file:' || old.path;
  INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
  VALUES (
    'file:' || new.path,
    'file',
    new.path,
    new.path,
    new.lang || CASE WHEN new.is_test = 1 THEN ' test' ELSE ' source' END,
    new.path,
    '',
    new.present
  );
END;

CREATE TRIGGER IF NOT EXISTS search_files_ad
AFTER DELETE ON files BEGIN
  DELETE FROM search_documents WHERE id = 'file:' || old.path;
END;

CREATE TRIGGER IF NOT EXISTS search_symbols_ai
AFTER INSERT ON symbols BEGIN
  DELETE FROM search_documents WHERE id = 'symbol:' || new.id;
  INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
  VALUES (
    'symbol:' || new.id,
    'symbol',
    new.id,
    new.name,
    new.kind || ' ' || COALESCE(new.signature, '') ||
      CASE WHEN new.exported = 1 THEN ' exported' ELSE '' END,
    new.path,
    new.name,
    1
  );
END;

CREATE TRIGGER IF NOT EXISTS search_symbols_au
AFTER UPDATE ON symbols BEGIN
  DELETE FROM search_documents WHERE id = 'symbol:' || old.id;
  INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
  VALUES (
    'symbol:' || new.id,
    'symbol',
    new.id,
    new.name,
    new.kind || ' ' || COALESCE(new.signature, '') ||
      CASE WHEN new.exported = 1 THEN ' exported' ELSE '' END,
    new.path,
    new.name,
    1
  );
END;

CREATE TRIGGER IF NOT EXISTS search_symbols_ad
AFTER DELETE ON symbols BEGIN
  DELETE FROM search_documents WHERE id = 'symbol:' || old.id;
END;

-- Human knowledge retains inactive rows for history but normal retrieval only
-- admits active documents.
CREATE TRIGGER IF NOT EXISTS search_memories_ai
AFTER INSERT ON memories BEGIN
  DELETE FROM search_documents WHERE id = 'memory:' || new.id;
  INSERT INTO search_documents(
    id, kind, source_id, title, body, path, symbol, active, updated_at
  ) VALUES (
    'memory:' || new.id,
    'memory',
    new.id,
    new.title,
    new.kind || ' ' || new.source || ' ' || new.body,
    '',
    '',
    CASE WHEN new.status = 'active' THEN 1 ELSE 0 END,
    new.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS search_memories_au
AFTER UPDATE ON memories BEGIN
  DELETE FROM search_documents WHERE id = 'memory:' || old.id;
  INSERT INTO search_documents(
    id, kind, source_id, title, body, path, symbol, active, updated_at
  ) VALUES (
    'memory:' || new.id,
    'memory',
    new.id,
    new.title,
    new.kind || ' ' || new.source || ' ' || new.body,
    COALESCE((
      SELECT group_concat(anchor_path, ' ')
      FROM (
        SELECT a.path AS anchor_path
        FROM memory_anchors a
        WHERE a.memory_id = new.id
        ORDER BY a.path, a.symbol
      )
    ), ''),
    COALESCE((
      SELECT group_concat(anchor_symbol, ' ')
      FROM (
        SELECT a.symbol AS anchor_symbol
        FROM memory_anchors a
        WHERE a.memory_id = new.id AND a.symbol != ''
        ORDER BY a.path, a.symbol
      )
    ), ''),
    CASE WHEN new.status = 'active' THEN 1 ELSE 0 END,
    new.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS search_memories_ad
AFTER DELETE ON memories BEGIN
  DELETE FROM search_documents WHERE id = 'memory:' || old.id;
END;

CREATE TRIGGER IF NOT EXISTS search_memory_anchors_ai
AFTER INSERT ON memory_anchors BEGIN
  UPDATE search_documents SET
    path = COALESCE((
      SELECT group_concat(anchor_path, ' ')
      FROM (
        SELECT a.path AS anchor_path
        FROM memory_anchors a
        WHERE a.memory_id = new.memory_id
        ORDER BY a.path, a.symbol
      )
    ), ''),
    symbol = COALESCE((
      SELECT group_concat(anchor_symbol, ' ')
      FROM (
        SELECT a.symbol AS anchor_symbol
        FROM memory_anchors a
        WHERE a.memory_id = new.memory_id AND a.symbol != ''
        ORDER BY a.path, a.symbol
      )
    ), '')
  WHERE id = 'memory:' || new.memory_id;
END;

CREATE TRIGGER IF NOT EXISTS search_memory_anchors_ad
AFTER DELETE ON memory_anchors BEGIN
  UPDATE search_documents SET
    path = COALESCE((
      SELECT group_concat(anchor_path, ' ')
      FROM (
        SELECT a.path AS anchor_path
        FROM memory_anchors a
        WHERE a.memory_id = old.memory_id
        ORDER BY a.path, a.symbol
      )
    ), ''),
    symbol = COALESCE((
      SELECT group_concat(anchor_symbol, ' ')
      FROM (
        SELECT a.symbol AS anchor_symbol
        FROM memory_anchors a
        WHERE a.memory_id = old.memory_id AND a.symbol != ''
        ORDER BY a.path, a.symbol
      )
    ), '')
  WHERE id = 'memory:' || old.memory_id;
END;

CREATE TRIGGER IF NOT EXISTS search_memory_anchors_au
AFTER UPDATE ON memory_anchors BEGIN
  UPDATE search_documents SET
    path = COALESCE((
      SELECT group_concat(anchor_path, ' ')
      FROM (
        SELECT a.path AS anchor_path
        FROM memory_anchors a
        WHERE a.memory_id = old.memory_id
        ORDER BY a.path, a.symbol
      )
    ), ''),
    symbol = COALESCE((
      SELECT group_concat(anchor_symbol, ' ')
      FROM (
        SELECT a.symbol AS anchor_symbol
        FROM memory_anchors a
        WHERE a.memory_id = old.memory_id AND a.symbol != ''
        ORDER BY a.path, a.symbol
      )
    ), '')
  WHERE id = 'memory:' || old.memory_id;
  UPDATE search_documents SET
    path = COALESCE((
      SELECT group_concat(anchor_path, ' ')
      FROM (
        SELECT a.path AS anchor_path
        FROM memory_anchors a
        WHERE a.memory_id = new.memory_id
        ORDER BY a.path, a.symbol
      )
    ), ''),
    symbol = COALESCE((
      SELECT group_concat(anchor_symbol, ' ')
      FROM (
        SELECT a.symbol AS anchor_symbol
        FROM memory_anchors a
        WHERE a.memory_id = new.memory_id AND a.symbol != ''
        ORDER BY a.path, a.symbol
      )
    ), '')
  WHERE id = 'memory:' || new.memory_id;
END;

CREATE TRIGGER IF NOT EXISTS search_findings_ai
AFTER INSERT ON findings BEGIN
  DELETE FROM search_documents WHERE id = 'finding:' || new.id;
  INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
  VALUES (
    'finding:' || new.id,
    'finding',
    new.id,
    new.title,
    new.rule_id || ' ' || new.category || ' ' || new.severity || ' ' ||
      new.confidence || ' ' || new.source || ' ' || new.description || ' ' ||
      COALESCE(new.suggestion, ''),
    COALESCE(new.path, ''),
    '',
    CASE WHEN new.status IN ('open', 'regressed') THEN 1 ELSE 0 END
  );
END;

CREATE TRIGGER IF NOT EXISTS search_findings_au
AFTER UPDATE ON findings BEGIN
  DELETE FROM search_documents WHERE id = 'finding:' || old.id;
  INSERT INTO search_documents(id, kind, source_id, title, body, path, symbol, active)
  VALUES (
    'finding:' || new.id,
    'finding',
    new.id,
    new.title,
    new.rule_id || ' ' || new.category || ' ' || new.severity || ' ' ||
      new.confidence || ' ' || new.source || ' ' || new.description || ' ' ||
      COALESCE(new.suggestion, ''),
    COALESCE(new.path, ''),
    '',
    CASE WHEN new.status IN ('open', 'regressed') THEN 1 ELSE 0 END
  );
END;

CREATE TRIGGER IF NOT EXISTS search_findings_ad
AFTER DELETE ON findings BEGIN
  DELETE FROM search_documents WHERE id = 'finding:' || old.id;
END;

-- Semantic map entities include their member anchors so a path or symbol can
-- retrieve the human explanation that contains it.
CREATE TRIGGER IF NOT EXISTS search_components_ai
AFTER INSERT ON components BEGIN
  DELETE FROM search_documents WHERE id = 'component:' || new.id;
  INSERT INTO search_documents(
    id, kind, source_id, title, body, path, symbol, active, updated_at
  ) VALUES (
    'component:' || new.id,
    'component',
    new.id,
    new.name,
    new.kind || ' ' || new.summary,
    '',
    '',
    1,
    new.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS search_components_au
AFTER UPDATE ON components BEGIN
  DELETE FROM search_documents WHERE id = 'component:' || old.id;
  INSERT INTO search_documents(
    id, kind, source_id, title, body, path, symbol, active, updated_at
  ) VALUES (
    'component:' || new.id,
    'component',
    new.id,
    new.name,
    new.kind || ' ' || new.summary || ' ' || COALESCE((
      SELECT group_concat(member_text, ' ')
      FROM (
        SELECT cm.pattern || ' ' || cm.symbol AS member_text
        FROM component_members cm
        WHERE cm.component_id = new.id
        ORDER BY cm.pattern, cm.symbol
      )
    ), ''),
    COALESCE((
      SELECT group_concat(member_path, ' ')
      FROM (
        SELECT cm.pattern AS member_path
        FROM component_members cm
        WHERE cm.component_id = new.id
        ORDER BY cm.pattern, cm.symbol
      )
    ), ''),
    '',
    1,
    new.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS search_components_ad
AFTER DELETE ON components BEGIN
  DELETE FROM search_documents WHERE id = 'component:' || old.id;
END;

CREATE TRIGGER IF NOT EXISTS search_component_members_ai
AFTER INSERT ON component_members BEGIN
  UPDATE search_documents SET
    body = COALESCE((SELECT kind || ' ' || summary FROM components WHERE id = new.component_id), '') ||
      ' ' || COALESCE((
        SELECT group_concat(member_text, ' ')
        FROM (
          SELECT cm.pattern || ' ' || cm.symbol AS member_text
          FROM component_members cm
          WHERE cm.component_id = new.component_id
          ORDER BY cm.pattern, cm.symbol
        )
      ), ''),
    path = COALESCE((
      SELECT group_concat(member_path, ' ')
      FROM (
        SELECT cm.pattern AS member_path
        FROM component_members cm
        WHERE cm.component_id = new.component_id
        ORDER BY cm.pattern, cm.symbol
      )
    ), '')
  WHERE id = 'component:' || new.component_id;
END;

CREATE TRIGGER IF NOT EXISTS search_component_members_ad
AFTER DELETE ON component_members BEGIN
  UPDATE search_documents SET
    body = COALESCE((SELECT kind || ' ' || summary FROM components WHERE id = old.component_id), '') ||
      ' ' || COALESCE((
        SELECT group_concat(member_text, ' ')
        FROM (
          SELECT cm.pattern || ' ' || cm.symbol AS member_text
          FROM component_members cm
          WHERE cm.component_id = old.component_id
          ORDER BY cm.pattern, cm.symbol
        )
      ), ''),
    path = COALESCE((
      SELECT group_concat(member_path, ' ')
      FROM (
        SELECT cm.pattern AS member_path
        FROM component_members cm
        WHERE cm.component_id = old.component_id
        ORDER BY cm.pattern, cm.symbol
      )
    ), '')
  WHERE id = 'component:' || old.component_id;
END;

CREATE TRIGGER IF NOT EXISTS search_component_members_au
AFTER UPDATE ON component_members BEGIN
  UPDATE search_documents SET
    body = COALESCE((SELECT kind || ' ' || summary FROM components WHERE id = old.component_id), '') ||
      ' ' || COALESCE((
        SELECT group_concat(member_text, ' ')
        FROM (
          SELECT cm.pattern || ' ' || cm.symbol AS member_text
          FROM component_members cm
          WHERE cm.component_id = old.component_id
          ORDER BY cm.pattern, cm.symbol
        )
      ), ''),
    path = COALESCE((
      SELECT group_concat(member_path, ' ')
      FROM (
        SELECT cm.pattern AS member_path
        FROM component_members cm
        WHERE cm.component_id = old.component_id
        ORDER BY cm.pattern, cm.symbol
      )
    ), '')
  WHERE id = 'component:' || old.component_id;
  UPDATE search_documents SET
    body = COALESCE((SELECT kind || ' ' || summary FROM components WHERE id = new.component_id), '') ||
      ' ' || COALESCE((
        SELECT group_concat(member_text, ' ')
        FROM (
          SELECT cm.pattern || ' ' || cm.symbol AS member_text
          FROM component_members cm
          WHERE cm.component_id = new.component_id
          ORDER BY cm.pattern, cm.symbol
        )
      ), ''),
    path = COALESCE((
      SELECT group_concat(member_path, ' ')
      FROM (
        SELECT cm.pattern AS member_path
        FROM component_members cm
        WHERE cm.component_id = new.component_id
        ORDER BY cm.pattern, cm.symbol
      )
    ), '')
  WHERE id = 'component:' || new.component_id;
END;

CREATE TRIGGER IF NOT EXISTS search_flows_ai
AFTER INSERT ON flows BEGIN
  DELETE FROM search_documents WHERE id = 'flow:' || new.id;
  INSERT INTO search_documents(
    id, kind, source_id, title, body, path, symbol, active, updated_at
  ) VALUES (
    'flow:' || new.id,
    'flow',
    new.id,
    new.name,
    new.summary || ' ' || COALESCE(new.trigger, ''),
    '',
    '',
    1,
    new.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS search_flows_au
AFTER UPDATE ON flows BEGIN
  DELETE FROM search_documents WHERE id = 'flow:' || old.id;
  INSERT INTO search_documents(
    id, kind, source_id, title, body, path, symbol, active, updated_at
  ) VALUES (
    'flow:' || new.id,
    'flow',
    new.id,
    new.name,
    new.summary || ' ' || COALESCE(new.trigger, '') || ' ' || COALESCE((
      SELECT group_concat(step_text, ' ')
      FROM (
        SELECT fs.label || ' ' || COALESCE(fs.note, '') AS step_text
        FROM flow_steps fs
        WHERE fs.flow_id = new.id
        ORDER BY fs.ordinal
      )
    ), ''),
    COALESCE((
      SELECT group_concat(step_path, ' ')
      FROM (
        SELECT fs.path AS step_path
        FROM flow_steps fs
        WHERE fs.flow_id = new.id AND fs.path IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), ''),
    COALESCE((
      SELECT group_concat(step_symbol, ' ')
      FROM (
        SELECT fs.symbol AS step_symbol
        FROM flow_steps fs
        WHERE fs.flow_id = new.id AND fs.symbol IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), ''),
    1,
    new.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS search_flows_ad
AFTER DELETE ON flows BEGIN
  DELETE FROM search_documents WHERE id = 'flow:' || old.id;
END;

CREATE TRIGGER IF NOT EXISTS search_flow_steps_ai
AFTER INSERT ON flow_steps BEGIN
  UPDATE search_documents SET
    body = COALESCE((
      SELECT summary || ' ' || COALESCE(trigger, '') FROM flows WHERE id = new.flow_id
    ), '') || ' ' || COALESCE((
      SELECT group_concat(step_text, ' ')
      FROM (
        SELECT fs.label || ' ' || COALESCE(fs.note, '') AS step_text
        FROM flow_steps fs
        WHERE fs.flow_id = new.flow_id
        ORDER BY fs.ordinal
      )
    ), ''),
    path = COALESCE((
      SELECT group_concat(step_path, ' ')
      FROM (
        SELECT fs.path AS step_path
        FROM flow_steps fs
        WHERE fs.flow_id = new.flow_id AND fs.path IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), ''),
    symbol = COALESCE((
      SELECT group_concat(step_symbol, ' ')
      FROM (
        SELECT fs.symbol AS step_symbol
        FROM flow_steps fs
        WHERE fs.flow_id = new.flow_id AND fs.symbol IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), '')
  WHERE id = 'flow:' || new.flow_id;
END;

CREATE TRIGGER IF NOT EXISTS search_flow_steps_ad
AFTER DELETE ON flow_steps BEGIN
  UPDATE search_documents SET
    body = COALESCE((
      SELECT summary || ' ' || COALESCE(trigger, '') FROM flows WHERE id = old.flow_id
    ), '') || ' ' || COALESCE((
      SELECT group_concat(step_text, ' ')
      FROM (
        SELECT fs.label || ' ' || COALESCE(fs.note, '') AS step_text
        FROM flow_steps fs
        WHERE fs.flow_id = old.flow_id
        ORDER BY fs.ordinal
      )
    ), ''),
    path = COALESCE((
      SELECT group_concat(step_path, ' ')
      FROM (
        SELECT fs.path AS step_path
        FROM flow_steps fs
        WHERE fs.flow_id = old.flow_id AND fs.path IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), ''),
    symbol = COALESCE((
      SELECT group_concat(step_symbol, ' ')
      FROM (
        SELECT fs.symbol AS step_symbol
        FROM flow_steps fs
        WHERE fs.flow_id = old.flow_id AND fs.symbol IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), '')
  WHERE id = 'flow:' || old.flow_id;
END;

CREATE TRIGGER IF NOT EXISTS search_flow_steps_au
AFTER UPDATE ON flow_steps BEGIN
  UPDATE search_documents SET
    body = COALESCE((
      SELECT summary || ' ' || COALESCE(trigger, '') FROM flows WHERE id = old.flow_id
    ), '') || ' ' || COALESCE((
      SELECT group_concat(step_text, ' ')
      FROM (
        SELECT fs.label || ' ' || COALESCE(fs.note, '') AS step_text
        FROM flow_steps fs
        WHERE fs.flow_id = old.flow_id
        ORDER BY fs.ordinal
      )
    ), ''),
    path = COALESCE((
      SELECT group_concat(step_path, ' ')
      FROM (
        SELECT fs.path AS step_path
        FROM flow_steps fs
        WHERE fs.flow_id = old.flow_id AND fs.path IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), ''),
    symbol = COALESCE((
      SELECT group_concat(step_symbol, ' ')
      FROM (
        SELECT fs.symbol AS step_symbol
        FROM flow_steps fs
        WHERE fs.flow_id = old.flow_id AND fs.symbol IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), '')
  WHERE id = 'flow:' || old.flow_id;
  UPDATE search_documents SET
    body = COALESCE((
      SELECT summary || ' ' || COALESCE(trigger, '') FROM flows WHERE id = new.flow_id
    ), '') || ' ' || COALESCE((
      SELECT group_concat(step_text, ' ')
      FROM (
        SELECT fs.label || ' ' || COALESCE(fs.note, '') AS step_text
        FROM flow_steps fs
        WHERE fs.flow_id = new.flow_id
        ORDER BY fs.ordinal
      )
    ), ''),
    path = COALESCE((
      SELECT group_concat(step_path, ' ')
      FROM (
        SELECT fs.path AS step_path
        FROM flow_steps fs
        WHERE fs.flow_id = new.flow_id AND fs.path IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), ''),
    symbol = COALESCE((
      SELECT group_concat(step_symbol, ' ')
      FROM (
        SELECT fs.symbol AS step_symbol
        FROM flow_steps fs
        WHERE fs.flow_id = new.flow_id AND fs.symbol IS NOT NULL
        ORDER BY fs.ordinal
      )
    ), '')
  WHERE id = 'flow:' || new.flow_id;
END;

CREATE TRIGGER IF NOT EXISTS search_relations_ai
AFTER INSERT ON relations BEGIN
  DELETE FROM search_documents WHERE id = 'relation:' || new.id;
  INSERT INTO search_documents(
    id, kind, source_id, title, body, path, symbol, active, updated_at
  ) VALUES (
    'relation:' || new.id,
    'relation',
    new.id,
    COALESCE(new.label, new.kind),
    new.kind || ' ' || new.evidence || ' ' || new.confidence || ' ' || new.source,
    new.src_path || ' ' || COALESCE(new.dst_path, ''),
    COALESCE(new.src_symbol, '') || ' ' || COALESCE(new.dst_symbol, ''),
    1,
    new.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS search_relations_au
AFTER UPDATE ON relations BEGIN
  DELETE FROM search_documents WHERE id = 'relation:' || old.id;
  INSERT INTO search_documents(
    id, kind, source_id, title, body, path, symbol, active, updated_at
  ) VALUES (
    'relation:' || new.id,
    'relation',
    new.id,
    COALESCE(new.label, new.kind),
    new.kind || ' ' || new.evidence || ' ' || new.confidence || ' ' || new.source,
    new.src_path || ' ' || COALESCE(new.dst_path, ''),
    COALESCE(new.src_symbol, '') || ' ' || COALESCE(new.dst_symbol, ''),
    1,
    new.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS search_relations_ad
AFTER DELETE ON relations BEGIN
  DELETE FROM search_documents WHERE id = 'relation:' || old.id;
END;

-- Refuse to commit a projection whose external-content index and relational
-- content table disagree. A migration failure rolls the whole schema step
-- back and retains the pre-migration recovery image.
INSERT INTO knowledge_fts(knowledge_fts, rank) VALUES('integrity-check', 1);
