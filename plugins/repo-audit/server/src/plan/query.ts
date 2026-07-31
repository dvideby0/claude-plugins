/**
 * Read-only queries agents can pull during review, so context is fetched on
 * demand instead of pushed up front.
 */

import type { Db } from "../db/db.js";

export const QUERY_KINDS = [
  "symbol",
  "importers",
  "imports",
  "findings",
  "hotspots",
  "externals",
  "cycles",
] as const;

export type QueryKind = (typeof QUERY_KINDS)[number];

export function runQuery(
  db: Db,
  kind: QueryKind,
  arg: string | undefined,
  limit = 50,
): unknown {
  switch (kind) {
    case "symbol":
      return db.all(
        `SELECT name, kind, path, start_line, end_line, exported, signature
           FROM symbols WHERE name = ? OR name LIKE ? ORDER BY exported DESC, path LIMIT ?`,
        [arg ?? "", `${arg ?? ""}%`, limit],
      );

    case "importers":
      return db.all(
        `SELECT e.src_path AS importer, f.lang, f.churn
           FROM edges e JOIN files f ON f.path = e.src_path
          WHERE e.dst_path = ? ORDER BY e.src_path LIMIT ?`,
        [arg ?? "", limit],
      );

    case "imports":
      return db.all(
        `SELECT specifier, dst_path, external FROM edges
          WHERE src_path = ? ORDER BY specifier LIMIT ?`,
        [arg ?? "", limit],
      );

    case "findings":
      return db.all(
        `SELECT id, rule_id, severity, category, source, path, line_start, title, status
           FROM findings
          WHERE status IN ('open','regressed')
            AND (? = '' OR path = ? OR severity = ? OR category = ? OR source = ?)
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                 WHEN 'medium' THEN 2 ELSE 3 END, path
          LIMIT ?`,
        [arg ?? "", arg ?? "", arg ?? "", arg ?? "", arg ?? "", limit],
      );

    case "hotspots":
      return db.all(
        `SELECT f.path, f.loc, f.churn,
                (SELECT COUNT(*) FROM edges e WHERE e.dst_path = f.path) AS fan_in,
                (SELECT COUNT(*) FROM findings x
                  WHERE x.path = f.path AND x.status IN ('open','regressed')) AS open_findings
           FROM files f WHERE f.present = 1 AND f.is_test = 0
          ORDER BY fan_in DESC, f.churn DESC LIMIT ?`,
        [limit],
      );

    case "externals":
      return db.all(
        `SELECT external AS package, COUNT(DISTINCT src_path) AS used_by
           FROM edges WHERE external IS NOT NULL
          GROUP BY external ORDER BY used_by DESC LIMIT ?`,
        [limit],
      );

    case "cycles":
      return db.all(
        `SELECT path, title, description FROM findings
          WHERE rule_id = 'graph/import-cycle' AND status IN ('open','regressed') LIMIT ?`,
        [limit],
      );
  }
}
