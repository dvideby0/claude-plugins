//! Native SQLite ownership for the local knowledge store.
//!
//! The Node boundary deliberately exchanges JSON rather than exposing a
//! second query abstraction. TypeScript keeps its small, synchronous `Db`
//! adapter while SQLite, transactions, journaling, and persistence live in
//! the same N-API binary the desktop app already ships.

use napi::{Error, Result, Status};
use napi_derive::napi;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde_json::{Map, Number};
use std::sync::{Mutex, MutexGuard};

fn invalid_argument(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn database_error(context: &str, error: rusqlite::Error) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
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

/// One directly persisted SQLite connection, owned by the engine process.
#[napi]
pub struct NativeDatabase {
    connection: Mutex<Option<Connection>>,
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
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA busy_timeout = 5000;",
            )
            .map_err(|error| database_error("Cannot configure SQLite store", error))?;

        Ok(Self {
            connection: Mutex::new(Some(connection)),
        })
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
        let mut statement = connection
            .prepare(&sql)
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
    fn persists_transactions_and_supports_fts5() {
        let path = temp_database();
        {
            let database = NativeDatabase::new(path.clone(), true).expect("database opens");
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
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{path}-wal"));
        let _ = fs::remove_file(format!("{path}-shm"));
    }
}
