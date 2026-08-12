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
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

const DATABASE_SCHEMA_VERSION: u32 = 18;
const FIRST_VERSIONED_SCHEMA: u32 = 17;
const SCHEMA_V17_SQL: &str = include_str!("database_schema_v17.sql");
const SCHEMA_V18_SQL: &str = include_str!("database_schema_v18.sql");
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

fn invalid_argument(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn database_error(context: &str, error: rusqlite::Error) -> Error {
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

fn search_knowledge_json(
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
                -bm25(knowledge_fts, 10.0, 1.0, 6.0, 8.0) AS score,
                snippet(knowledge_fts, -1, '[', ']', ' … ', 24) AS excerpt
         FROM knowledge_fts
         JOIN search_documents d ON d.rowid = knowledge_fts.rowid
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
