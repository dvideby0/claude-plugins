//! Native SQLite ownership for the local knowledge store.
//!
//! The Node boundary deliberately exchanges JSON rather than exposing a
//! second query abstraction. TypeScript keeps its small, synchronous `Db`
//! adapter while SQLite, transactions, journaling, and persistence live in
//! the same N-API binary the desktop app already ships.

use napi::bindgen_prelude::{AsyncTask, Env, Task};
use napi::{Error, Result, Status};
use napi_derive::napi;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension, MAIN_DB};
use serde_json::{Map, Number};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

const DATABASE_SCHEMA_VERSION: u32 = 25;
const FIRST_VERSIONED_SCHEMA: u32 = 17;
const SCHEMA_V17_SQL: &str = include_str!("database_schema_v17.sql");
const SCHEMA_V18_SQL: &str = include_str!("database_schema_v18.sql");
const SCHEMA_V19_SQL: &str = include_str!("database_schema_v19.sql");
const SCHEMA_V20_SQL: &str = include_str!("database_schema_v20.sql");
const SCHEMA_V21_SQL: &str = include_str!("database_schema_v21.sql");
const SCHEMA_V22_SQL: &str = include_str!("database_schema_v22.sql");
const SCHEMA_V23_SQL: &str = include_str!("database_schema_v23.sql");
const SCHEMA_V24_SQL: &str = include_str!("database_schema_v24.sql");
const SCHEMA_V25_SQL: &str = include_str!("database_schema_v25.sql");
const SEARCH_KINDS: &[&str] = &[
    "file",
    "symbol",
    "memory",
    "finding",
    "component",
    "flow",
    "relation",
];
const MEMORY_KINDS: &[&str] = &[
    "decision",
    "convention",
    "constraint",
    "gotcha",
    "context",
    "todo",
];

const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("refs", "src_symbol", "TEXT"),
    ("refs", "src_column", "INTEGER NOT NULL DEFAULT 0"),
    ("refs", "src_end_column", "INTEGER"),
    ("refs", "src_symbol_id", "TEXT"),
    ("refs", "dst_line", "INTEGER"),
    ("refs", "dst_column", "INTEGER"),
    ("refs", "dst_end_line", "INTEGER"),
    ("refs", "dst_end_column", "INTEGER"),
    ("refs", "dst_symbol_id", "TEXT"),
    ("symbols", "default_export", "INTEGER NOT NULL DEFAULT 0"),
    ("symbols", "start_column", "INTEGER NOT NULL DEFAULT 0"),
    ("symbols", "end_column", "INTEGER NOT NULL DEFAULT 0"),
    ("files", "ref_coverage", "TEXT NOT NULL DEFAULT 'none'"),
    ("files", "ref_generation", "TEXT"),
    ("files", "ref_source_signature", "TEXT"),
    ("components", "member_digest", "TEXT"),
    ("flow_steps", "content_sha", "TEXT"),
];

pub(crate) fn invalid_argument(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

pub(crate) fn database_error(context: &str, error: rusqlite::Error) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn storage_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn configure_connection(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| database_error("Cannot configure SQLite store", error))
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|error| database_error("Cannot inspect SQLite schema", error))
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    // All callers pass compile-time table names from ADDED_COLUMNS.
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| database_error("Cannot inspect SQLite columns", error))?;
    let mut rows = statement
        .query([])
        .map_err(|error| database_error("Cannot inspect SQLite columns", error))?;
    while let Some(row) = rows
        .next()
        .map_err(|error| database_error("Cannot inspect SQLite columns", error))?
    {
        let name: String = row
            .get(1)
            .map_err(|error| database_error("Cannot read SQLite column metadata", error))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn stored_schema_version(connection: &Connection) -> Result<u32> {
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| database_error("Cannot read SQLite user_version", error))?;
    let meta_version = if table_exists(connection, "meta")? {
        connection
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| database_error("Cannot read prototype schema version", error))?
            .map(|value| {
                value.parse::<u32>().map_err(|_| {
                    invalid_argument(format!(
                        "SQLite workspace store has invalid schema_version {value}"
                    ))
                })
            })
            .transpose()?
            .unwrap_or(0)
    } else {
        0
    };
    let user_version = u32::try_from(user_version).map_err(|_| {
        invalid_argument(format!(
            "SQLite workspace store has invalid user_version {user_version}"
        ))
    })?;
    if user_version > 0 && meta_version > 0 && user_version != meta_version {
        return Err(invalid_argument(format!(
            "SQLite workspace store has conflicting schema versions (user_version {user_version}, meta {meta_version}) and was left untouched"
        )));
    }
    Ok(if user_version > 0 {
        user_version
    } else {
        meta_version
    })
}

fn assert_integrity(connection: &Connection, context: &str) -> Result<()> {
    let mut statement = connection
        .prepare("PRAGMA quick_check")
        .map_err(|error| database_error("Cannot start SQLite integrity check", error))?;
    let failures: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| database_error("Cannot run SQLite integrity check", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read SQLite integrity result", error))?
        .into_iter()
        .filter(|result| result != "ok")
        .take(5)
        .collect();
    if failures.is_empty() {
        return Ok(());
    }
    Err(Error::new(
        Status::GenericFailure,
        format!(
            "SQLite integrity check failed {context}: {}. The store was left untouched.",
            failures.join("; ")
        ),
    ))
}

fn has_user_state(connection: &Connection) -> Result<bool> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .map_err(|error| database_error("Cannot inspect SQLite store contents", error))
}

fn assert_migration_recorded(connection: &Connection, version: u32) -> Result<()> {
    if !table_exists(connection, "schema_migrations")? {
        return Err(invalid_argument(format!(
            "SQLite schema v{version} is missing its migration ledger"
        )));
    }
    let recorded = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
            [version],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| database_error("Cannot verify SQLite migration ledger", error))?;
    if recorded == 1 {
        return Ok(());
    }
    Err(invalid_argument(format!(
        "SQLite schema v{version} is missing its migration ledger entry"
    )))
}

#[cfg(unix)]
fn set_private_permissions(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut sidecar = path.as_os_str().to_os_string();
    sidecar.push(suffix);
    PathBuf::from(sidecar)
}

fn remove_file_if_present(path: &Path, context: &str) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(storage_error(context, error)),
    }
}

fn remove_sqlite_sidecars(path: &Path) -> Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        remove_file_if_present(
            &sqlite_sidecar_path(path, suffix),
            "Cannot remove SQLite recovery sidecar",
        )?;
    }
    Ok(())
}

fn cleanup_database_artifacts(path: &Path) {
    let _ = remove_file_if_present(path, "Cannot remove SQLite recovery artifact");
    let _ = remove_sqlite_sidecars(path);
}

fn cleanup_stale_migration_artifacts(directory: &Path) -> Result<()> {
    let entries = fs::read_dir(directory)
        .map_err(|error| storage_error("Cannot inspect SQLite recovery directory", error))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| storage_error("Cannot inspect SQLite recovery entry", error))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let is_temporary = name.starts_with("pre-v")
            && name.contains(".db.")
            && [".tmp", ".tmp-wal", ".tmp-shm", ".tmp-journal"]
                .iter()
                .any(|suffix| name.ends_with(suffix));
        if is_temporary {
            remove_file_if_present(&path, "Cannot remove stale SQLite recovery artifact")?;
        }
    }
    Ok(())
}

fn normalize_backup(path: &Path) -> Result<()> {
    let backup = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| database_error("Cannot normalize SQLite recovery backup", error))?;
    backup
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|error| database_error("Cannot make SQLite recovery backup standalone", error))?;
    let journal_mode: String = backup
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|error| database_error("Cannot verify SQLite recovery journal mode", error))?;
    drop(backup);
    remove_sqlite_sidecars(path)?;
    if journal_mode.eq_ignore_ascii_case("delete") {
        return Ok(());
    }
    Err(Error::new(
        Status::GenericFailure,
        format!(
            "SQLite recovery backup remained in {journal_mode} journal mode instead of becoming a standalone file"
        ),
    ))
}

fn validate_backup(path: &Path) -> Result<()> {
    let backup = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| database_error("Cannot open SQLite recovery backup", error))?;
    let journal_mode: String = backup
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|error| database_error("Cannot read SQLite recovery journal mode", error))?;
    if !journal_mode.eq_ignore_ascii_case("delete") {
        return Err(Error::new(
            Status::GenericFailure,
            format!("SQLite recovery backup is not standalone: journal mode is {journal_mode}"),
        ));
    }
    assert_integrity(&backup, "for recovery backup")
}

fn create_migration_backup(connection: &Connection, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err(invalid_argument(format!(
            "Refusing to replace existing SQLite recovery backup: {}",
            destination.display()
        )));
    }

    let parent = destination.parent().ok_or_else(|| {
        invalid_argument(format!(
            "SQLite recovery backup has no parent: {}",
            destination.display()
        ))
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| storage_error("Cannot create SQLite recovery directory", error))?;
    set_private_permissions(parent, 0o700)
        .map_err(|error| storage_error("Cannot protect SQLite recovery directory", error))?;
    cleanup_stale_migration_artifacts(parent)?;

    let destination_name = destination.file_name().ok_or_else(|| {
        invalid_argument(format!(
            "SQLite recovery backup has no file name: {}",
            destination.display()
        ))
    })?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| storage_error("Cannot timestamp SQLite recovery backup", error))?
        .as_nanos();
    let mut temporary_name = destination_name.to_os_string();
    temporary_name.push(format!(".{}.{nonce}.tmp", std::process::id()));
    let temporary = parent.join(temporary_name);
    let result = (|| -> Result<()> {
        connection
            .backup(MAIN_DB, &temporary, None)
            .map_err(|error| database_error("Cannot create SQLite recovery backup", error))?;
        normalize_backup(&temporary)?;
        validate_backup(&temporary)?;
        set_private_permissions(&temporary, 0o600)
            .map_err(|error| storage_error("Cannot protect SQLite recovery backup", error))?;
        fs::rename(&temporary, destination)
            .map_err(|error| storage_error("Cannot publish SQLite recovery backup", error))?;
        Ok(())
    })();
    if result.is_err() {
        cleanup_database_artifacts(&temporary);
    }
    result
}

fn migration_backup_path(directory: &Path, target_version: u32) -> Result<PathBuf> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| storage_error("Cannot timestamp SQLite recovery backup", error))?
        .as_nanos();
    Ok(directory.join(format!("pre-v{target_version}-{nonce}.db")))
}

fn retain_latest_migration_backup(
    directory: &Path,
    target_version: u32,
    latest: &Path,
) -> Result<()> {
    let prefix = format!("pre-v{target_version}-");
    let entries = fs::read_dir(directory)
        .map_err(|error| storage_error("Cannot inspect SQLite recovery directory", error))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| storage_error("Cannot inspect SQLite recovery entry", error))?;
        let path = entry.path();
        if path == latest {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with(&prefix) || !name.ends_with(".db") {
            continue;
        }
        remove_file_if_present(&path, "Cannot retire superseded SQLite recovery backup")?;
        // Sidecars are not recovery images; failure to remove one must not
        // discard the newer validated image that replaced its main database.
        let _ = remove_sqlite_sidecars(&path);
    }
    Ok(())
}

fn migrate_legacy_schema(connection: &Connection) -> Result<()> {
    for (table, column, column_type) in ADDED_COLUMNS {
        if !table_exists(connection, table)? || has_column(connection, table, column)? {
            continue;
        }
        connection
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {column_type}"),
                [],
            )
            .map_err(|error| database_error("Cannot add legacy SQLite column", error))?;
    }

    if !table_exists(connection, "refs")? {
        return Ok(());
    }
    let mut statement = connection
        .prepare("PRAGMA table_info(refs)")
        .map_err(|error| database_error("Cannot inspect legacy refs table", error))?;
    let mut key_columns: Vec<(i64, String)> = statement
        .query_map([], |row| Ok((row.get(5)?, row.get(1)?)))
        .map_err(|error| database_error("Cannot inspect legacy refs key", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read legacy refs key", error))?
        .into_iter()
        .filter(|(position, _)| *position > 0)
        .collect();
    key_columns.sort_by_key(|(position, _)| *position);
    if key_columns.iter().any(|(_, column)| column == "src_column") {
        return Ok(());
    }

    connection
        .execute_batch(
            "DROP TABLE IF EXISTS refs_v12;
             CREATE TABLE refs_v12 (
               src_path TEXT NOT NULL,
               src_line INTEGER NOT NULL,
               src_column INTEGER NOT NULL DEFAULT 0,
               src_end_column INTEGER,
               name TEXT NOT NULL,
               specifier TEXT NOT NULL,
               dst_path TEXT,
               src_symbol TEXT,
               src_symbol_id TEXT,
               dst_line INTEGER,
               dst_column INTEGER,
               dst_end_line INTEGER,
               dst_end_column INTEGER,
               dst_symbol_id TEXT,
               PRIMARY KEY (src_path, src_line, src_column, name, specifier)
             );
             INSERT OR REPLACE INTO refs_v12(
               src_path, src_line, src_column, src_end_column, name, specifier, dst_path,
               src_symbol, src_symbol_id, dst_line, dst_column, dst_end_line, dst_end_column,
               dst_symbol_id
             )
             SELECT src_path, src_line, src_column, src_end_column, name, specifier, dst_path,
                    src_symbol, src_symbol_id, dst_line, dst_column, dst_end_line, dst_end_column,
                    dst_symbol_id
               FROM refs;
             DROP TABLE refs;
             ALTER TABLE refs_v12 RENAME TO refs;",
        )
        .map_err(|error| database_error("Cannot rebuild legacy refs table", error))
}

fn apply_migration(connection: &Connection, version: u32) -> Result<()> {
    match version {
        17 => {
            migrate_legacy_schema(connection)?;
            connection
                .execute_batch(SCHEMA_V17_SQL)
                .map_err(|error| database_error("Cannot install SQLite schema v17", error))
        }
        18 => connection
            .execute_batch(SCHEMA_V18_SQL)
            .map_err(|error| database_error("Cannot install SQLite schema v18", error)),
        19 => connection
            .execute_batch(SCHEMA_V19_SQL)
            .map_err(|error| database_error("Cannot install SQLite schema v19", error)),
        20 => connection
            .execute_batch(SCHEMA_V20_SQL)
            .map_err(|error| database_error("Cannot install SQLite schema v20", error)),
        21 => connection
            .execute_batch(SCHEMA_V21_SQL)
            .map_err(|error| database_error("Cannot install SQLite schema v21", error)),
        22 => connection
            .execute_batch(SCHEMA_V22_SQL)
            .map_err(|error| database_error("Cannot install SQLite schema v22", error)),
        23 => connection
            .execute_batch(SCHEMA_V23_SQL)
            .map_err(|error| database_error("Cannot install SQLite schema v23", error)),
        24 => connection
            .execute_batch(SCHEMA_V24_SQL)
            .map_err(|error| database_error("Cannot install SQLite schema v24", error)),
        25 => connection
            .execute_batch(SCHEMA_V25_SQL)
            .map_err(|error| database_error("Cannot install SQLite schema v25", error)),
        _ => Err(invalid_argument(format!(
            "No SQLite migration is registered for schema v{version}"
        ))),
    }
}

/** Current Rust-owned workspace-store schema version. */
#[napi]
pub fn database_schema_version() -> u32 {
    DATABASE_SCHEMA_VERSION
}

fn parse_params(params_json: &str) -> Result<Vec<Value>> {
    let values: Vec<serde_json::Value> = serde_json::from_str(params_json)
        .map_err(|error| invalid_argument(format!("Invalid SQLite parameter JSON: {error}")))?;

    values
        .into_iter()
        .map(|value| match value {
            serde_json::Value::Null => Ok(Value::Null),
            serde_json::Value::Bool(value) => Ok(Value::Integer(i64::from(value))),
            serde_json::Value::Number(value) => {
                if let Some(integer) = value.as_i64() {
                    Ok(Value::Integer(integer))
                } else if let Some(float) = value.as_f64() {
                    Ok(Value::Real(float))
                } else {
                    Err(invalid_argument("SQLite numeric parameter is out of range"))
                }
            }
            serde_json::Value::String(value) => Ok(Value::Text(value)),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(invalid_argument(
                "SQLite parameters must be strings, numbers, booleans, or null",
            )),
        })
        .collect()
}

fn row_value(value: ValueRef<'_>) -> Result<serde_json::Value> {
    match value {
        ValueRef::Null => Ok(serde_json::Value::Null),
        ValueRef::Integer(value) => Ok(serde_json::Value::Number(Number::from(value))),
        ValueRef::Real(value) => Number::from_f64(value)
            .map(serde_json::Value::Number)
            .ok_or_else(|| {
                database_error(
                    "SQLite returned a non-finite number",
                    rusqlite::Error::InvalidQuery,
                )
            }),
        ValueRef::Text(value) => Ok(serde_json::Value::String(
            String::from_utf8_lossy(value).into_owned(),
        )),
        ValueRef::Blob(_) => Err(Error::new(
            Status::GenericFailure,
            "SQLite BLOB results are not supported by the knowledge-store boundary".to_string(),
        )),
    }
}

fn query_json(connection: &Connection, sql: &str, params: &[Value]) -> Result<String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| database_error("Cannot prepare SQLite query", error))?;
    let columns: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(ToOwned::to_owned)
        .collect();
    let mut rows = statement
        .query(params_from_iter(params.iter()))
        .map_err(|error| database_error("Cannot execute SQLite query", error))?;
    let mut result = Vec::new();

    while let Some(row) = rows
        .next()
        .map_err(|error| database_error("Cannot read SQLite row", error))?
    {
        let mut object = Map::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let value = row
                .get_ref(index)
                .map_err(|error| database_error("Cannot read SQLite value", error))?;
            object.insert(column.clone(), row_value(value)?);
        }
        result.push(serde_json::Value::Object(object));
    }

    serde_json::to_string(&result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Cannot encode SQLite rows: {error}"),
        )
    })
}

fn fts_query(input: &str) -> Result<Option<String>> {
    if input.chars().count() > 512 {
        return Err(invalid_argument(
            "Knowledge search query must be at most 512 characters",
        ));
    }

    let mut terms = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, terms: &mut Vec<String>| {
        if current.is_empty() || terms.len() >= 8 {
            current.clear();
            return;
        }
        let normalized = current.to_lowercase();
        if !terms.iter().any(|term| term == &normalized) {
            terms.push(normalized);
        }
        current.clear();
    };

    for character in input.chars() {
        if character.is_alphanumeric() {
            if current.chars().count() < 64 {
                current.push(character);
            }
        } else {
            flush(&mut current, &mut terms);
        }
        if terms.len() >= 8 {
            break;
        }
    }
    flush(&mut current, &mut terms);

    if terms.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        terms
            .into_iter()
            .map(|term| {
                let prefix = if term.chars().count() >= 3 { "*" } else { "" };
                format!("\"{term}\"{prefix}")
            })
            .collect::<Vec<_>>()
            .join(" OR "),
    ))
}

fn parse_search_kinds(kinds_json: &str) -> Result<Vec<String>> {
    let kinds: Vec<String> = serde_json::from_str(kinds_json)
        .map_err(|error| invalid_argument(format!("Invalid knowledge search kinds: {error}")))?;
    let mut validated = Vec::new();
    for kind in kinds {
        if !SEARCH_KINDS.contains(&kind.as_str()) {
            return Err(invalid_argument(format!(
                "Unknown knowledge search kind {kind}. Expected one of: {}",
                SEARCH_KINDS.join(", ")
            )));
        }
        if !validated.contains(&kind) {
            validated.push(kind);
        }
    }
    Ok(validated)
}

fn parse_memory_kind(memory_kind: Option<&str>) -> Result<Option<String>> {
    let Some(memory_kind) = memory_kind else {
        return Ok(None);
    };
    if !MEMORY_KINDS.contains(&memory_kind) {
        return Err(invalid_argument(format!(
            "Unknown memory kind {memory_kind}. Expected one of: {}",
            MEMORY_KINDS.join(", ")
        )));
    }
    Ok(Some(memory_kind.to_string()))
}

pub(crate) fn search_knowledge_json(
    connection: &Connection,
    query: &str,
    kinds_json: &str,
    limit: u32,
    memory_kind: Option<&str>,
) -> Result<String> {
    let Some(match_query) = fts_query(query)? else {
        return Ok("[]".to_string());
    };
    let kinds = parse_search_kinds(kinds_json)?;
    let memory_kind = parse_memory_kind(memory_kind)?;
    if memory_kind.is_some() && !kinds.is_empty() && !kinds.iter().any(|kind| kind == "memory") {
        return Err(invalid_argument(
            "A memory subtype filter requires the memory knowledge kind",
        ));
    }
    let limit = limit.clamp(1, 100);
    let mut sql = String::from(
        "SELECT d.kind,
                d.source_id,
                d.title,
                d.path,
                d.symbol,
                d.updated_at,
                COALESCE(s.start_line, f.line_start) AS line_start,
                COALESCE(s.end_line, f.line_end) AS line_end,
                f.content_sha AS evidence_sha,
                -bm25(knowledge_fts, 10.0, 1.0, 6.0, 8.0) AS score,
                snippet(knowledge_fts, -1, '[', ']', ' … ', 24) AS excerpt
         FROM knowledge_fts
         JOIN search_documents d ON d.rowid = knowledge_fts.rowid
         LEFT JOIN symbols s ON d.kind = 'symbol' AND s.id = d.source_id
         LEFT JOIN findings f ON d.kind = 'finding' AND f.id = d.source_id
         WHERE knowledge_fts MATCH ?1 AND d.active = 1",
    );
    let mut values = vec![
        Value::Text(match_query),
        Value::Text(query.trim().to_string()),
    ];
    if !kinds.is_empty() {
        let placeholders = (0..kinds.len())
            .map(|index| format!("?{}", index + 3))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" AND d.kind IN ({placeholders})"));
        values.extend(kinds.into_iter().map(Value::Text));
    }
    if let Some(memory_kind) = memory_kind {
        let memory_kind_parameter = values.len() + 1;
        sql.push_str(&format!(
            " AND d.kind = 'memory'
              AND EXISTS (
                SELECT 1 FROM memories m
                WHERE m.id = d.source_id AND m.kind = ?{memory_kind_parameter}
              )"
        ));
        values.push(Value::Text(memory_kind));
    }
    let limit_parameter = values.len() + 1;
    sql.push_str(&format!(
        " ORDER BY
            CASE WHEN LOWER(d.title) = LOWER(?2)
                    OR LOWER(d.path) = LOWER(?2)
                    OR LOWER(d.symbol) = LOWER(?2)
                 THEN 0 ELSE 1 END,
            bm25(knowledge_fts, 10.0, 1.0, 6.0, 8.0),
            d.kind,
            d.title
          LIMIT ?{limit_parameter}"
    ));
    values.push(Value::Integer(i64::from(limit)));
    query_json(connection, &sql, &values)
}

#[derive(Clone)]
struct ExecutionEntryRow {
    id: String,
    kind: String,
    label: String,
    method: String,
    route: String,
    path: String,
    symbol: String,
    start_line: u32,
    end_line: u32,
    producer_id: String,
    producer_version: String,
    producer_kind: String,
    certainty: String,
    input_sha: String,
    freshness: String,
    terminal_effects: u32,
    gaps: u32,
}

#[derive(Clone)]
struct ExecutionNodeRow {
    id: String,
    ordinal: u32,
    kind: String,
    label: String,
    path: String,
    symbol: String,
    target_path: Option<String>,
    target_symbol: String,
    target_start_line: Option<u32>,
    target_end_line: Option<u32>,
    external: String,
    start_line: u32,
    end_line: u32,
    certainty: String,
    terminal: bool,
    detail: String,
}

#[derive(Clone)]
struct ExecutionEdgeRow {
    ordinal: u32,
    src_id: String,
    dst_id: String,
    kind: String,
    label: String,
    path: String,
    start_line: u32,
    certainty: String,
}

struct ExecutionPath {
    node_ids: Vec<String>,
    edge_ordinals: Vec<u32>,
    conditions: Vec<String>,
    terminal_node_id: Option<String>,
    certainty: String,
    complete: bool,
}

#[derive(Clone)]
struct ExecutionAssertionRow {
    id: String,
    kind: String,
    src_path: String,
    src_symbol: Option<String>,
    dst_path: Option<String>,
    dst_symbol: Option<String>,
    label: Option<String>,
    evidence: String,
    evidence_line: Option<u32>,
    confidence: String,
    source: String,
    content_sha: String,
}

fn execution_entry_value(entry: &ExecutionEntryRow) -> serde_json::Value {
    serde_json::json!({
        "id": entry.id,
        "kind": entry.kind,
        "label": entry.label,
        "method": entry.method,
        "route": entry.route,
        "path": entry.path,
        "symbol": entry.symbol,
        "evidence": {
            "path": entry.path,
            "startLine": entry.start_line,
            "endLine": entry.end_line,
        },
        "producer": {
            "id": entry.producer_id,
            "version": entry.producer_version,
            "kind": entry.producer_kind,
        },
        "certainty": entry.certainty,
        "freshness": entry.freshness,
        "generation": { "inputSha": entry.input_sha },
        "terminalEffects": entry.terminal_effects,
        "gaps": entry.gaps,
    })
}

fn execution_node_has_unresolved_target(node: &ExecutionNodeRow) -> bool {
    matches!(node.kind.as_str(), "call" | "await")
        && node.target_path.as_deref().unwrap_or("").is_empty()
        && node.external.is_empty()
}

fn execution_node_resolution(node: &ExecutionNodeRow) -> &'static str {
    match node.kind.as_str() {
        "call" | "await" if execution_node_has_unresolved_target(node) => "unresolved",
        "call" | "await" if !node.external.is_empty() => "external",
        "call" | "await" => "resolved",
        "terminal-effect" if !node.external.is_empty() => "external",
        _ => "not-applicable",
    }
}

fn execution_node_value(node: &ExecutionNodeRow) -> serde_json::Value {
    serde_json::json!({
        "id": node.id,
        "ordinal": node.ordinal,
        "kind": node.kind,
        "label": node.label,
        "path": node.path,
        "symbol": node.symbol,
        "target": {
            "path": node.target_path,
            "symbol": node.target_symbol,
            "startLine": node.target_start_line,
            "endLine": node.target_end_line,
            "external": node.external,
        },
        "evidence": {
            "path": node.path,
            "startLine": node.start_line,
            "endLine": node.end_line,
        },
        "certainty": node.certainty,
        "resolution": execution_node_resolution(node),
        "terminal": node.terminal,
        "detail": node.detail,
    })
}

fn execution_edge_value(edge: &ExecutionEdgeRow) -> serde_json::Value {
    serde_json::json!({
        "id": edge.ordinal,
        "from": edge.src_id,
        "to": edge.dst_id,
        "kind": edge.kind,
        "label": edge.label,
        "evidence": { "path": edge.path, "startLine": edge.start_line },
        "certainty": edge.certainty,
    })
}

fn execution_endpoint_matches(
    endpoint_path: Option<&str>,
    endpoint_symbol: Option<&str>,
    candidate_path: &str,
    candidate_symbol: &str,
) -> bool {
    endpoint_path.is_some_and(|path| path == candidate_path)
        && endpoint_symbol.is_none_or(|symbol| symbol.is_empty() || symbol == candidate_symbol)
}

fn execution_assertion_anchors(
    assertion: &ExecutionAssertionRow,
    nodes: &[ExecutionNodeRow],
) -> Vec<serde_json::Value> {
    let mut anchors = Vec::new();
    let mut seen = HashSet::new();
    for node in nodes {
        let locations = [
            (Some(node.path.as_str()), node.symbol.as_str()),
            (node.target_path.as_deref(), node.target_symbol.as_str()),
        ];
        for (path, symbol) in locations {
            if execution_endpoint_matches(
                Some(assertion.src_path.as_str()),
                assertion.src_symbol.as_deref(),
                path.unwrap_or_default(),
                symbol,
            ) && seen.insert((node.id.clone(), "source"))
            {
                anchors.push(serde_json::json!({
                    "nodeId": node.id,
                    "relationEndpoint": "source",
                }));
            }
            if execution_endpoint_matches(
                assertion.dst_path.as_deref(),
                assertion.dst_symbol.as_deref(),
                path.unwrap_or_default(),
                symbol,
            ) && seen.insert((node.id.clone(), "target"))
            {
                anchors.push(serde_json::json!({
                    "nodeId": node.id,
                    "relationEndpoint": "target",
                }));
            }
        }
    }
    anchors
}

fn execution_asserted_overlay(
    connection: &Connection,
    nodes: &[ExecutionNodeRow],
    enabled: bool,
) -> Result<serde_json::Value> {
    const MAX_ASSERTIONS: usize = 128;
    const NOTE: &str = "Authored relations are evidence-backed assertions, not deterministic path facts. Only assertions whose evidence source is current are shown.";
    if !enabled {
        return Ok(serde_json::json!({
            "enabled": false,
            "note": NOTE,
            "relations": [],
            "truncated": false,
        }));
    }

    let mut relevant_endpoints = nodes
        .iter()
        .flat_map(|node| {
            [
                Some((node.path.as_str(), node.symbol.as_str())),
                node.target_path
                    .as_deref()
                    .map(|path| (path, node.target_symbol.as_str())),
            ]
        })
        .flatten()
        .filter(|(path, _)| !path.is_empty())
        .map(|(path, symbol)| (path.to_owned(), symbol.to_owned()))
        .collect::<Vec<_>>();
    relevant_endpoints.sort();
    relevant_endpoints.dedup();
    if relevant_endpoints.is_empty() {
        return Ok(serde_json::json!({
            "enabled": true,
            "note": NOTE,
            "relations": [],
            "truncated": false,
        }));
    }

    let placeholders = (0..relevant_endpoints.len())
        .map(|index| format!("(?{}, ?{})", index * 2 + 1, index * 2 + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let limit_parameter = relevant_endpoints.len() * 2 + 1;
    let sql = format!(
        "WITH relevant(path, symbol) AS (VALUES {placeholders})
         SELECT r.id, r.kind, r.src_path, r.src_symbol, r.dst_path, r.dst_symbol,
                r.label, r.evidence,
                CASE WHEN typeof(r.evidence_line) = 'integer'
                           AND r.evidence_line BETWEEN 1 AND 4294967295
                     THEN r.evidence_line ELSE NULL END,
                r.confidence, r.source, r.content_sha
         FROM relations r
         JOIN files f ON f.path = r.src_path
                     AND f.present = 1
                     -- An assertion describes what code means, so reformatting
                     -- its source must not drop it from the overlay while every
                     -- other reader still calls it current. Content remains the
                     -- comparison where either side has no syntax signature.
                     AND CASE
                           WHEN r.syntax_sha IS NOT NULL AND f.syntax_sha IS NOT NULL
                             THEN f.syntax_sha = r.syntax_sha
                           ELSE f.content_sha = r.content_sha
                         END
         WHERE EXISTS (
           SELECT 1 FROM relevant endpoint
           WHERE (r.src_path = endpoint.path
                  AND (COALESCE(r.src_symbol, '') = '' OR r.src_symbol = endpoint.symbol))
              OR (r.dst_path = endpoint.path
                  AND (COALESCE(r.dst_symbol, '') = '' OR r.dst_symbol = endpoint.symbol))
         )
         ORDER BY r.updated_at DESC, r.id
         LIMIT ?{limit_parameter}"
    );
    let mut values = relevant_endpoints
        .into_iter()
        .flat_map(|(path, symbol)| [Value::Text(path), Value::Text(symbol)])
        .collect::<Vec<_>>();
    values.push(Value::Integer((MAX_ASSERTIONS + 1) as i64));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| database_error("Cannot prepare execution assertion query", error))?;
    let mut assertion_rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok(ExecutionAssertionRow {
                id: row.get(0)?,
                kind: row.get(1)?,
                src_path: row.get(2)?,
                src_symbol: row.get(3)?,
                dst_path: row.get(4)?,
                dst_symbol: row.get(5)?,
                label: row.get(6)?,
                evidence: row.get(7)?,
                evidence_line: row.get(8)?,
                confidence: row.get(9)?,
                source: row.get(10)?,
                content_sha: row.get(11)?,
            })
        })
        .map_err(|error| database_error("Cannot query execution assertions", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read execution assertions", error))?;

    let truncated = assertion_rows.len() > MAX_ASSERTIONS;
    assertion_rows.truncate(MAX_ASSERTIONS);
    let mut relations = Vec::new();
    for assertion in assertion_rows {
        let anchors = execution_assertion_anchors(&assertion, nodes);
        if anchors.is_empty() {
            continue;
        }
        relations.push(serde_json::json!({
            "id": assertion.id,
            "kind": assertion.kind,
            "label": assertion.label,
            "from": {
                "path": assertion.src_path,
                "symbol": assertion.src_symbol,
            },
            "to": {
                "path": assertion.dst_path,
                "symbol": assertion.dst_symbol,
            },
            "evidence": {
                "path": assertion.src_path,
                "startLine": assertion.evidence_line,
                "text": assertion.evidence,
                "contentSha": assertion.content_sha,
            },
            "provenance": {
                "source": assertion.source,
                "certainty": "asserted",
                "confidence": assertion.confidence,
                "freshness": "current",
            },
            "anchors": anchors,
        }));
    }
    Ok(serde_json::json!({
        "enabled": true,
        "note": NOTE,
        "relations": relations,
        "truncated": truncated,
    }))
}

fn weakest_certainty(current: &str, candidate: &str) -> String {
    const ORDER: &[&str] = &[
        "exact",
        "observed",
        "inferred",
        "asserted",
        "ambiguous",
        "unknown",
    ];
    let current_rank = ORDER
        .iter()
        .position(|value| *value == current)
        .unwrap_or(ORDER.len());
    let candidate_rank = ORDER
        .iter()
        .position(|value| *value == candidate)
        .unwrap_or(ORDER.len());
    if candidate_rank > current_rank {
        candidate.to_string()
    } else {
        current.to_string()
    }
}

#[allow(clippy::too_many_arguments)]
fn walk_execution_paths(
    node_id: &str,
    nodes: &HashMap<String, ExecutionNodeRow>,
    outgoing: &HashMap<String, Vec<ExecutionEdgeRow>>,
    visited: &mut HashSet<String>,
    node_ids: &mut Vec<String>,
    edge_ordinals: &mut Vec<u32>,
    conditions: &mut Vec<String>,
    certainty: &str,
    paths: &mut Vec<ExecutionPath>,
    diagnostics: &mut Vec<String>,
    max_paths: usize,
) {
    if paths.len() >= max_paths {
        return;
    }
    let Some(node) = nodes.get(node_id) else {
        diagnostics.push(format!(
            "Execution graph references missing node {node_id}."
        ));
        return;
    };
    let certainty = weakest_certainty(certainty, &node.certainty);
    node_ids.push(node.id.clone());
    if node.terminal {
        let complete = node_ids.iter().all(|id| {
            nodes.get(id).is_some_and(|visited| {
                visited.kind != "gap" && !execution_node_has_unresolved_target(visited)
            })
        });
        paths.push(ExecutionPath {
            node_ids: node_ids.clone(),
            edge_ordinals: edge_ordinals.clone(),
            conditions: conditions.clone(),
            terminal_node_id: Some(node.id.clone()),
            certainty,
            complete,
        });
        node_ids.pop();
        return;
    }
    if node_ids.len() >= 64 {
        diagnostics.push("Execution path exceeded 64 nodes and was truncated.".to_string());
        paths.push(ExecutionPath {
            node_ids: node_ids.clone(),
            edge_ordinals: edge_ordinals.clone(),
            conditions: conditions.clone(),
            terminal_node_id: None,
            certainty: "unknown".to_string(),
            complete: false,
        });
        node_ids.pop();
        return;
    }

    let edges = outgoing.get(node_id).cloned().unwrap_or_default();
    if edges.is_empty() {
        paths.push(ExecutionPath {
            node_ids: node_ids.clone(),
            edge_ordinals: edge_ordinals.clone(),
            conditions: conditions.clone(),
            terminal_node_id: None,
            certainty: "unknown".to_string(),
            complete: false,
        });
        node_ids.pop();
        return;
    }

    for edge in edges {
        if paths.len() >= max_paths {
            break;
        }
        if !visited.insert(edge.dst_id.clone()) {
            diagnostics.push(format!(
                "Cycle from {} to {} was bounded during path enumeration.",
                edge.src_id, edge.dst_id
            ));
            continue;
        }
        edge_ordinals.push(edge.ordinal);
        let condition_added =
            !edge.label.is_empty() && matches!(edge.kind.as_str(), "branch" | "catch" | "throw");
        if condition_added {
            conditions.push(edge.label.clone());
        }
        let edge_certainty = weakest_certainty(&certainty, &edge.certainty);
        walk_execution_paths(
            &edge.dst_id,
            nodes,
            outgoing,
            visited,
            node_ids,
            edge_ordinals,
            conditions,
            &edge_certainty,
            paths,
            diagnostics,
            max_paths,
        );
        if condition_added {
            conditions.pop();
        }
        edge_ordinals.pop();
        visited.remove(&edge.dst_id);
    }
    node_ids.pop();
}

fn execution_flow_json(
    connection: &Connection,
    selected_entry_id: Option<&str>,
    max_paths: u32,
    include_assertions: bool,
) -> Result<String> {
    if selected_entry_id.is_some_and(|id| id.is_empty() || id.chars().count() > 512) {
        return Err(invalid_argument(
            "Execution entry id must contain between 1 and 512 characters",
        ));
    }
    let mut statement = connection
        .prepare(
            "SELECT e.id, e.kind, e.label, e.method, e.route, e.path, e.symbol,
                    e.start_line, e.end_line, e.producer_id, e.producer_version,
                    e.producer_kind, e.certainty, e.input_sha,
                    -- Freshness is about meaning, so it compares syntax where
                    -- both sides have it. A comment added above a route does
                    -- not change what the route does. Content is the fallback
                    -- for an index predating syntax signatures, which must
                    -- report stale rather than claim an unverifiable current.
                    CASE
                      WHEN f.present != 1 THEN 'stale'
                      WHEN e.syntax_sha IS NOT NULL AND f.syntax_sha IS NOT NULL
                        THEN CASE WHEN f.syntax_sha = e.syntax_sha THEN 'current' ELSE 'stale' END
                      WHEN f.content_sha = e.input_sha THEN 'current'
                      ELSE 'stale'
                    END AS freshness,
                    (SELECT COUNT(*) FROM execution_nodes n
                     WHERE n.entry_id = e.id AND n.kind = 'terminal-effect') AS terminal_effects,
                    (SELECT COUNT(*) FROM execution_nodes n
                     WHERE n.entry_id = e.id
                       AND (n.kind = 'gap'
                         OR (n.kind IN ('call', 'await')
                           AND COALESCE(n.target_path, '') = ''
                           AND n.external = ''))) AS gaps
             FROM execution_entries e
             LEFT JOIN files f ON f.path = e.path
             ORDER BY e.kind, e.method, e.route, e.path, e.start_line",
        )
        .map_err(|error| database_error("Cannot prepare execution entry query", error))?;
    let entries = statement
        .query_map([], |row| {
            Ok(ExecutionEntryRow {
                id: row.get(0)?,
                kind: row.get(1)?,
                label: row.get(2)?,
                method: row.get(3)?,
                route: row.get(4)?,
                path: row.get(5)?,
                symbol: row.get(6)?,
                start_line: row.get(7)?,
                end_line: row.get(8)?,
                producer_id: row.get(9)?,
                producer_version: row.get(10)?,
                producer_kind: row.get(11)?,
                certainty: row.get(12)?,
                input_sha: row.get(13)?,
                freshness: row.get(14)?,
                terminal_effects: row.get(15)?,
                gaps: row.get(16)?,
            })
        })
        .map_err(|error| database_error("Cannot query execution entries", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read execution entries", error))?;
    let entry_values = entries
        .iter()
        .map(execution_entry_value)
        .collect::<Vec<_>>();
    let mut inventory_diagnostic_statement = connection
        .prepare(
            "SELECT DISTINCT message FROM execution_diagnostics
             WHERE message LIKE '%inventory was truncated%'
                OR message LIKE '%remaining alternatives were not indexed%'
             ORDER BY message LIMIT 128",
        )
        .map_err(|error| database_error("Cannot prepare execution inventory diagnostics", error))?;
    let inventory_diagnostics = inventory_diagnostic_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| database_error("Cannot query execution inventory diagnostics", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read execution inventory diagnostics", error))?;

    let Some(entry_id) = selected_entry_id else {
        return serde_json::to_string(&serde_json::json!({
            "schemaVersion": 4,
            "model": "entry-to-effect",
            "note": if entries.is_empty() {
                Some("No deterministic execution entries are indexed. Re-index after installing an adapter that recognizes this repository's entrypoints.")
            } else {
                None
            },
            "entries": entry_values,
            "diagnostics": inventory_diagnostics,
            "selected": serde_json::Value::Null,
        }))
        .map_err(|error| storage_error("Cannot encode execution entry response", error));
    };
    let Some(entry) = entries.iter().find(|entry| entry.id == entry_id) else {
        return serde_json::to_string(&serde_json::json!({
            "schemaVersion": 4,
            "model": "entry-to-effect",
            "note": "The requested execution entry is not present in the current index.",
            "entries": entry_values,
            "diagnostics": inventory_diagnostics,
            "selected": serde_json::Value::Null,
        }))
        .map_err(|error| storage_error("Cannot encode missing execution entry response", error));
    };

    let mut node_statement = connection
        .prepare(
            "SELECT n.id, n.ordinal, n.kind, n.label, n.path, n.symbol, n.target_path,
                    n.target_symbol,
                    (SELECT s.start_line
                     FROM refs r JOIN symbols s ON s.id = r.dst_symbol_id
                     WHERE r.src_path = n.path
                       AND r.src_line = n.target_line
                       AND r.src_column = n.target_column
                       AND r.dst_path = n.target_path
                     ORDER BY s.start_line, s.start_column LIMIT 1) AS target_start_line,
                    (SELECT s.end_line
                     FROM refs r JOIN symbols s ON s.id = r.dst_symbol_id
                     WHERE r.src_path = n.path
                       AND r.src_line = n.target_line
                       AND r.src_column = n.target_column
                       AND r.dst_path = n.target_path
                     ORDER BY s.start_line, s.start_column LIMIT 1) AS target_end_line,
                    n.external, n.start_line, n.end_line, n.certainty,
                    n.terminal, n.detail
             FROM execution_nodes n WHERE n.entry_id = ?1 ORDER BY n.ordinal LIMIT 512",
        )
        .map_err(|error| database_error("Cannot prepare execution node query", error))?;
    let node_rows = node_statement
        .query_map([entry_id], |row| {
            Ok(ExecutionNodeRow {
                id: row.get(0)?,
                ordinal: row.get(1)?,
                kind: row.get(2)?,
                label: row.get(3)?,
                path: row.get(4)?,
                symbol: row.get(5)?,
                target_path: row.get(6)?,
                target_symbol: row.get(7)?,
                target_start_line: row.get(8)?,
                target_end_line: row.get(9)?,
                external: row.get(10)?,
                start_line: row.get(11)?,
                end_line: row.get(12)?,
                certainty: row.get(13)?,
                terminal: row.get::<_, i64>(14)? != 0,
                detail: row.get(15)?,
            })
        })
        .map_err(|error| database_error("Cannot query execution nodes", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read execution nodes", error))?;
    let mut edge_statement = connection
        .prepare(
            "SELECT ordinal, src_id, dst_id, kind, label, path, start_line, certainty
             FROM execution_edges WHERE entry_id = ?1 ORDER BY ordinal LIMIT 1024",
        )
        .map_err(|error| database_error("Cannot prepare execution edge query", error))?;
    let edge_rows = edge_statement
        .query_map([entry_id], |row| {
            Ok(ExecutionEdgeRow {
                ordinal: row.get(0)?,
                src_id: row.get(1)?,
                dst_id: row.get(2)?,
                kind: row.get(3)?,
                label: row.get(4)?,
                path: row.get(5)?,
                start_line: row.get(6)?,
                certainty: row.get(7)?,
            })
        })
        .map_err(|error| database_error("Cannot query execution edges", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read execution edges", error))?;
    let mut diagnostic_statement = connection
        .prepare("SELECT message FROM execution_diagnostics WHERE entry_id = ?1 ORDER BY ordinal")
        .map_err(|error| database_error("Cannot prepare execution diagnostic query", error))?;
    let mut diagnostics = diagnostic_statement
        .query_map([entry_id], |row| row.get::<_, String>(0))
        .map_err(|error| database_error("Cannot query execution diagnostics", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("Cannot read execution diagnostics", error))?;
    for node in node_rows
        .iter()
        .filter(|node| execution_node_has_unresolved_target(node))
    {
        diagnostics.push(format!(
            "{}:{} cannot resolve the target of {}; paths through it are incomplete.",
            node.path, node.start_line, node.label
        ));
    }

    let nodes = node_rows
        .iter()
        .cloned()
        .map(|node| (node.id.clone(), node))
        .collect::<HashMap<_, _>>();
    let mut outgoing: HashMap<String, Vec<ExecutionEdgeRow>> = HashMap::new();
    for edge in &edge_rows {
        outgoing
            .entry(edge.src_id.clone())
            .or_default()
            .push(edge.clone());
    }
    for edges in outgoing.values_mut() {
        edges.sort_by_key(|edge| edge.ordinal);
    }
    let mut paths = Vec::new();
    let path_limit = max_paths.clamp(1, 64) as usize;
    if let Some(root) = node_rows.iter().find(|node| node.kind == "entry") {
        let mut visited = HashSet::from([root.id.clone()]);
        walk_execution_paths(
            &root.id,
            &nodes,
            &outgoing,
            &mut visited,
            &mut Vec::new(),
            &mut Vec::new(),
            &mut Vec::new(),
            &entry.certainty,
            &mut paths,
            &mut diagnostics,
            path_limit + 1,
        );
    } else {
        diagnostics.push("Execution entry has no root node.".to_string());
    }
    let paths_truncated = paths.len() > path_limit;
    if paths_truncated {
        paths.truncate(path_limit);
        diagnostics.push(format!(
            "Path enumeration reached the configured limit of {}.",
            path_limit
        ));
    }
    diagnostics.sort();
    diagnostics.dedup();
    let asserted_overlay = execution_asserted_overlay(connection, &node_rows, include_assertions)?;

    let path_values = paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let terminal = path
                .terminal_node_id
                .as_ref()
                .and_then(|id| nodes.get(id));
            let terminal_outcome = terminal.map_or_else(
                || {
                    serde_json::json!({
                        "kind": "gap",
                        "label": "Path ended before a terminal outcome",
                        "external": serde_json::Value::Null,
                    })
                },
                |node| {
                    serde_json::json!({
                        "kind": node.kind,
                        "label": node.label,
                        "external": if node.external.is_empty() {
                            serde_json::Value::Null
                        } else {
                            serde_json::Value::String(node.external.clone())
                        },
                    })
                },
            );
            serde_json::json!({
                "id": format!("{}:path:{index}", entry.id),
                "nodeIds": path.node_ids,
                "edgeIds": path.edge_ordinals,
                "conditions": path.conditions,
                "terminalNodeId": path.terminal_node_id,
                "terminalEffect": terminal.filter(|node| node.kind == "terminal-effect").map(|node| node.external.clone()),
                "terminalOutcome": terminal_outcome,
                "certainty": path.certainty,
                "complete": path.complete,
            })
        })
        .collect::<Vec<_>>();

    serde_json::to_string(&serde_json::json!({
        "schemaVersion": 4,
        "model": "entry-to-effect",
        "entries": entry_values,
        "diagnostics": inventory_diagnostics,
        "selected": {
            "entry": execution_entry_value(entry),
            "nodes": node_rows.iter().map(execution_node_value).collect::<Vec<_>>(),
            "edges": edge_rows.iter().map(execution_edge_value).collect::<Vec<_>>(),
            "paths": path_values,
            "diagnostics": diagnostics,
            "truncated": paths_truncated,
            "assertedOverlay": asserted_overlay,
        },
    }))
    .map_err(|error| storage_error("Cannot encode execution flow response", error))
}

/// One directly persisted SQLite connection, owned by the engine process.
#[napi]
pub struct NativeDatabase {
    connection: Arc<Mutex<Option<Connection>>>,
}

impl NativeDatabase {
    fn connection(&self) -> Result<MutexGuard<'_, Option<Connection>>> {
        self.connection.lock().map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "Native SQLite connection lock was poisoned".to_string(),
            )
        })
    }
}

fn migrate_connection(
    connection: &mut Connection,
    project_root: &str,
    backup_dir: &str,
) -> Result<()> {
    let target_version = DATABASE_SCHEMA_VERSION;
    let from_version = stored_schema_version(connection)?;
    if from_version > target_version {
        return Err(invalid_argument(format!(
            "SQLite workspace store uses schema v{from_version}, but this SDLC build supports v{target_version}. Upgrade SDLC instead of opening the store with an older build"
        )));
    }
    assert_integrity(connection, "before schema migration")?;
    if from_version >= FIRST_VERSIONED_SCHEMA {
        assert_migration_recorded(connection, from_version)?;
    }

    let needs_migration = from_version < target_version;
    let recovery_path = if needs_migration && has_user_state(connection)? {
        let directory = Path::new(backup_dir);
        let path = migration_backup_path(directory, target_version)?;
        create_migration_backup(connection, &path)?;
        if let Err(error) = retain_latest_migration_backup(directory, target_version, &path) {
            cleanup_database_artifacts(&path);
            return Err(error);
        }
        Some(path)
    } else {
        None
    };
    let migration = (|| -> Result<()> {
        configure_connection(connection)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| database_error("Cannot start SQLite schema migration", error))?;
        let mut version = from_version;
        while version < target_version {
            let next_version = if version < FIRST_VERSIONED_SCHEMA {
                FIRST_VERSIONED_SCHEMA
            } else {
                version + 1
            };
            apply_migration(&transaction, next_version)?;
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version, from_version, applied_at, backup_path)
                     VALUES(?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?3)",
                    params![
                        next_version,
                        version,
                        recovery_path
                            .as_ref()
                            .map(|path| path.to_string_lossy().into_owned())
                    ],
                )
                .map_err(|error| database_error("Cannot record SQLite migration", error))?;
            version = next_version;
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?1)",
                [target_version.to_string()],
            )
            .map_err(|error| database_error("Cannot record SQLite schema version", error))?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('project_root', ?1)",
                [project_root],
            )
            .map_err(|error| database_error("Cannot record SQLite workspace root", error))?;
        transaction
            .execute_batch(&format!("PRAGMA user_version = {target_version}"))
            .map_err(|error| database_error("Cannot publish SQLite schema version", error))?;
        if needs_migration {
            assert_integrity(&transaction, "after schema migration")?;
        }
        transaction
            .commit()
            .map_err(|error| database_error("Cannot commit SQLite schema migration", error))
    })();

    migration.map_err(|error| {
        let recovery = recovery_path
            .as_ref()
            .map(|path| {
                format!(
                    " Its pre-migration recovery image is {}.",
                    path.display()
                )
            })
            .unwrap_or_default();
        Error::new(
            Status::GenericFailure,
            format!(
                "{error} SQLite schema changes did not commit and the workspace store was not replaced.{recovery}"
            ),
        )
    })
}

pub struct MigrationTask {
    connection: Arc<Mutex<Option<Connection>>>,
    project_root: String,
    backup_dir: String,
}

#[napi]
impl Task for MigrationTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        let mut connection = self.connection.lock().map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "Native SQLite connection lock was poisoned".to_string(),
            )
        })?;
        let connection = connection.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "SQLite store is closed".to_string())
        })?;
        migrate_connection(connection, &self.project_root, &self.backup_dir)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
impl NativeDatabase {
    #[napi(constructor)]
    pub fn new(path: String, create_if_missing: bool) -> Result<Self> {
        let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        if create_if_missing {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }

        let connection = Connection::open_with_flags(&path, flags)
            .map_err(|error| database_error(&format!("Cannot open SQLite store {path}"), error))?;

        Ok(Self {
            connection: Arc::new(Mutex::new(Some(connection))),
        })
    }

    /// Validate, back up, and migrate a workspace store as one Rust-owned
    /// storage lifecycle. The final schema and ordered steps are compiled into
    /// this native owner; TypeScript never controls migration semantics.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn migrate(
        &self,
        project_root: String,
        backup_dir: String,
    ) -> Result<AsyncTask<MigrationTask>> {
        Ok(AsyncTask::new(MigrationTask {
            connection: Arc::clone(&self.connection),
            project_root,
            backup_dir,
        }))
    }

    #[napi]
    pub fn execute_batch(&self, sql: String) -> Result<()> {
        let connection = self.connection()?;
        let connection = connection.as_ref().ok_or_else(|| {
            Error::new(Status::GenericFailure, "SQLite store is closed".to_string())
        })?;
        connection
            .execute_batch(&sql)
            .map_err(|error| database_error("SQLite batch failed", error))
    }

    #[napi]
    pub fn run(&self, sql: String, params_json: String) -> Result<()> {
        let params = parse_params(&params_json)?;
        let connection = self.connection()?;
        let connection = connection.as_ref().ok_or_else(|| {
            Error::new(Status::GenericFailure, "SQLite store is closed".to_string())
        })?;
        connection
            .execute(&sql, params_from_iter(params.iter()))
            .map(|_| ())
            .map_err(|error| database_error("SQLite statement failed", error))
    }

    /// What the last scan recorded about each present file, for the walk.
    ///
    /// Produced here rather than assembled by the caller so the query, the
    /// shape and the comparison all stay on this side of the boundary. The
    /// caller forwards the string to `scanRepo` without reading it; it cannot
    /// grow a second opinion about what "unchanged" means, which is the same
    /// reason the input policy answers the walk and the watcher from one place.
    ///
    /// Rows without a `stat_key` are omitted: an absent key is not a baseline.
    #[napi]
    pub fn file_baseline(&self) -> Result<String> {
        let connection = self.connection()?;
        let connection = connection.as_ref().ok_or_else(|| {
            Error::new(Status::GenericFailure, "SQLite store is closed".to_string())
        })?;
        let last_run: i64 = connection
            .query_row("SELECT COALESCE(MAX(id), 0) FROM runs", [], |row| row.get(0))
            .map_err(|error| database_error("Cannot read the last run id", error))?;
        let files = query_json(
            connection,
            "SELECT path, stat_key AS statKey, content_sha AS contentSha, loc
               FROM files
              WHERE present = 1 AND stat_key IS NOT NULL",
            &[],
        )?;
        Ok(format!("{{\"lastRun\":{last_run},\"files\":{files}}}"))
    }

    #[napi]
    pub fn all(&self, sql: String, params_json: String) -> Result<String> {
        let params = parse_params(&params_json)?;
        let connection = self.connection()?;
        let connection = connection.as_ref().ok_or_else(|| {
            Error::new(Status::GenericFailure, "SQLite store is closed".to_string())
        })?;
        query_json(connection, &sql, &params)
    }

    /// Ranked lexical retrieval over deterministic facts and authored
    /// knowledge. Query syntax is generated here so callers never pass raw
    /// FTS expressions across the product boundary.
    #[napi]
    pub fn search_knowledge(
        &self,
        query: String,
        kinds_json: String,
        limit: u32,
        memory_kind: Option<String>,
    ) -> Result<String> {
        let connection = self.connection()?;
        let connection = connection.as_ref().ok_or_else(|| {
            Error::new(Status::GenericFailure, "SQLite store is closed".to_string())
        })?;
        search_knowledge_json(
            connection,
            &query,
            &kinds_json,
            limit,
            memory_kind.as_deref(),
        )
    }

    /// Rank task-relevant facts and one-hop graph evidence behind the existing
    /// intent-oriented briefing boundary. Source reading and final byte packing
    /// remain in the thin daemon adapter so repository containment has one
    /// implementation, while retrieval policy and ordering live with SQLite.
    #[napi]
    pub fn task_context(
        &self,
        task: String,
        targets_json: String,
        intent: Option<String>,
        limit: Option<u32>,
        changes_json: Option<String>,
    ) -> Result<String> {
        let connection = self.connection()?;
        let connection = connection.as_ref().ok_or_else(|| {
            Error::new(Status::GenericFailure, "SQLite store is closed".to_string())
        })?;
        crate::task_context::task_context_json(
            connection,
            &task,
            &targets_json,
            intent.as_deref(),
            limit.unwrap_or(64),
            changes_json.as_deref(),
        )
    }

    /// Query the bounded, evidence-backed execution graph assembled by native
    /// framework adapters. Path enumeration remains inside the native storage
    /// boundary and terminates on cycles and configured limits.
    #[napi]
    pub fn execution_flow(
        &self,
        entry_id: Option<String>,
        max_paths: Option<u32>,
        include_assertions: Option<bool>,
    ) -> Result<String> {
        let connection = self.connection()?;
        let connection = connection.as_ref().ok_or_else(|| {
            Error::new(Status::GenericFailure, "SQLite store is closed".to_string())
        })?;
        execution_flow_json(
            connection,
            entry_id.as_deref(),
            max_paths.unwrap_or(24),
            include_assertions.unwrap_or(false),
        )
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut connection = self.connection()?;
        connection.take();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_database() -> String {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sdlc-native-sqlite-{nonce}.db"));
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn migrates_ranked_knowledge_search_and_tracks_lifecycle() {
        let mut connection = Connection::open_in_memory().expect("database opens");
        migrate_connection(&mut connection, "/workspace", "/unused")
            .expect("fresh schema migrates");
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version is readable");
        assert_eq!(version, DATABASE_SCHEMA_VERSION);

        connection
            .execute_batch(
                "INSERT INTO files(path, lang, content_sha, present)
                   VALUES('src/core/db.ts', 'typescript', 'abc', 1);
                 INSERT INTO symbols(
                   id, path, kind, name, start_line, end_line, signature
                 ) VALUES(
                   'src/core/db.ts#function:query@1:0', 'src/core/db.ts',
                   'function', 'query', 1, 1, 'query(sql: string)'
                 );
                 INSERT INTO memories(
                   id, kind, title, body, source, status, created_at, updated_at
                 ) VALUES
                   ('primary', 'decision', 'Retry policy for uploads',
                    'Use three attempts.', 'human', 'active', 'now', 'now'),
                   ('secondary', 'context', 'Upload operations',
                    'The retry policy for uploads is documented elsewhere.',
                    'agent', 'active', 'now', 'now');
                 INSERT INTO memory_anchors(memory_id, path, symbol, content_sha)
                   VALUES('primary', 'src/core/db.ts', 'query', 'abc');",
            )
            .expect("search sources insert");

        let ranked: Vec<serde_json::Value> = serde_json::from_str(
            &search_knowledge_json(&connection, "retry uploads", "[\"memory\"]", 20, None)
                .expect("knowledge search succeeds"),
        )
        .expect("search result decodes");
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0]["source_id"], "primary");
        assert_eq!(ranked[0]["kind"], "memory");

        let partial: Vec<serde_json::Value> = serde_json::from_str(
            &search_knowledge_json(
                &connection,
                "retry term-that-is-not-present",
                "[\"memory\"]",
                20,
                None,
            )
            .expect("partial multi-term search succeeds"),
        )
        .expect("partial search result decodes");
        assert_eq!(partial.len(), 2);

        let decisions: Vec<serde_json::Value> = serde_json::from_str(
            &search_knowledge_json(&connection, "uploads", "[\"memory\"]", 20, Some("decision"))
                .expect("memory subtype search succeeds"),
        )
        .expect("memory subtype result decodes");
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0]["source_id"], "primary");

        let anchored: Vec<serde_json::Value> = serde_json::from_str(
            &search_knowledge_json(&connection, "src/core/db.ts", "[\"memory\"]", 20, None)
                .expect("path search succeeds"),
        )
        .expect("path result decodes");
        assert_eq!(anchored[0]["source_id"], "primary");

        let symbols: Vec<serde_json::Value> = serde_json::from_str(
            &search_knowledge_json(&connection, "query", "[\"symbol\"]", 20, None)
                .expect("symbol search succeeds"),
        )
        .expect("symbol result decodes");
        assert_eq!(symbols[0]["path"], "src/core/db.ts");

        let task_context: serde_json::Value = serde_json::from_str(
            &crate::task_context::task_context_json(
                &connection,
                "change the upload retry query",
                "[\"src/core/db.ts\"]",
                Some("implement"),
                20,
                None,
            )
            .expect("task context succeeds"),
        )
        .expect("task context decodes");
        assert_eq!(task_context["targets"][0]["status"], "resolved");
        let task_candidates = task_context["candidates"]
            .as_array()
            .expect("task candidates are an array");
        assert!(task_candidates
            .iter()
            .any(|candidate| candidate["id"] == "memory:primary"));
        assert!(task_candidates
            .iter()
            .any(|candidate| candidate["id"] == "symbol:src/core/db.ts#function:query@1:0"));
        assert!(task_context["uncertainties"][0]
            .as_str()
            .expect("reference uncertainty is text")
            .contains("no reference analysis"));

        connection
            .execute(
                "UPDATE memories SET status = 'superseded' WHERE id = 'primary'",
                [],
            )
            .expect("memory retires");
        let retired: Vec<serde_json::Value> = serde_json::from_str(
            &search_knowledge_json(&connection, "three attempts", "[\"memory\"]", 20, None)
                .expect("retired search succeeds"),
        )
        .expect("retired result decodes");
        assert!(retired.is_empty());

        // Punctuation is data, never raw FTS syntax supplied by the caller.
        search_knowledge_json(&connection, "query() OR \\\"unterminated", "[]", 20, None)
            .expect("unsafe-looking input is normalized safely");
    }

    #[test]
    fn persists_transactions_and_supports_fts5() {
        let path = temp_database();
        let backup_dir = format!("{path}.recovery");
        let backup_path = format!("{backup_dir}/backup.db");
        {
            let database = NativeDatabase::new(path.clone(), true).expect("database opens");
            {
                let connection = database.connection().expect("connection locks");
                configure_connection(connection.as_ref().expect("connection is open"))
                    .expect("database configures");
            }
            database
                .execute_batch(
                    "CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                     CREATE VIRTUAL TABLE search USING fts5(value);
                     BEGIN;
                     INSERT INTO facts(value) VALUES('deterministic code intelligence');
                     INSERT INTO search(value) VALUES('deterministic code intelligence');
                     COMMIT;"
                        .to_string(),
                )
                .expect("schema and transaction apply");
            let rows = database
                .all(
                    "SELECT value FROM search WHERE search MATCH ?".to_string(),
                    r#"["intelligence"]"#.to_string(),
                )
                .expect("FTS query works");
            assert!(rows.contains("deterministic code intelligence"));
            fs::create_dir_all(&backup_dir).expect("recovery directory is created");
            let stale = format!("{backup_dir}/pre-v17-1.db.123.456.tmp");
            fs::write(&stale, b"abandoned backup").expect("stale backup is created");
            fs::write(format!("{stale}-wal"), b"abandoned WAL")
                .expect("stale backup sidecar is created");
            {
                let connection = database.connection().expect("connection locks");
                create_migration_backup(
                    connection.as_ref().expect("connection is open"),
                    Path::new(&backup_path),
                )
                .expect("online backup succeeds");
            }
            let recovery_entries: Vec<PathBuf> = fs::read_dir(&backup_dir)
                .expect("recovery directory is readable")
                .map(|entry| entry.expect("recovery entry is readable").path())
                .collect();
            assert_eq!(recovery_entries, [PathBuf::from(&backup_path)]);
            let recovery = Connection::open_with_flags(
                &backup_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .expect("backup opens read-only");
            let journal_mode: String = recovery
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .expect("backup journal mode is readable");
            assert_eq!(journal_mode, "delete");
        }
        let reopened = NativeDatabase::new(path.clone(), false).expect("database reopens");
        let rows = reopened
            .all(
                "SELECT COUNT(*) AS count FROM facts".to_string(),
                "[]".to_string(),
            )
            .expect("persisted row can be read");
        assert_eq!(rows, r#"[{"count":1}]"#);
        drop(reopened);
        let backup = NativeDatabase::new(backup_path.clone(), false).expect("backup reopens");
        let backup_rows = backup
            .all("SELECT value FROM facts".to_string(), "[]".to_string())
            .expect("backup contains committed WAL data");
        assert!(backup_rows.contains("deterministic code intelligence"));
        drop(backup);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{path}-wal"));
        let _ = fs::remove_file(format!("{path}-shm"));
        let _ = fs::remove_file(&backup_path);
        let _ = fs::remove_file(format!("{backup_path}-wal"));
        let _ = fs::remove_file(format!("{backup_path}-shm"));
        let _ = fs::remove_dir(&backup_dir);
    }
}
