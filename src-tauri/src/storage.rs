use crate::model::{Error, Event};
use rusqlite::{Connection, params};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;
use std::sync::Mutex;

pub struct Storage {
    pub db: Mutex<Connection>,
}
impl Storage {
    pub fn open(path: &Path) -> Result<Self, Error> {
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(3))?;
        // This is Kitsune's internal database, never a connected user database.
        db.execute_batch("PRAGMA secure_delete=ON")?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 1 {
            return Err(Error::new(
                "STORAGE_VERSION",
                "Metadata was created by a newer Kitsune version.",
            ));
        }
        if version < 1 {
            db.execute_batch(&format!(
                "BEGIN IMMEDIATE;{} COMMIT;",
                include_str!("../migrations/001_initial.sql")
            ))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
                |_| {
                    Error::new(
                        "STORAGE_PERMISSIONS",
                        "Cannot secure metadata file permissions.",
                    )
                },
            )?;
        }
        Ok(Self { db: Mutex::new(db) })
    }
    pub fn list<T: DeserializeOwned>(&self, collection: &str) -> Result<Vec<T>, Error> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Storage lock unavailable."))?;
        let mut stmt =
            db.prepare("SELECT body FROM documents WHERE collection=? ORDER BY rowid DESC")?;
        let items = stmt
            .query_map([collection], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        items
            .into_iter()
            .map(|s| {
                serde_json::from_str(&s).map_err(|_| {
                    Error::new(
                        "STORAGE_CORRUPT",
                        "Stored metadata is invalid. The original file has been preserved.",
                    )
                })
            })
            .collect()
    }
    pub fn event_by_id(&self, id: &str) -> Result<Option<Event>, Error> {
        use rusqlite::OptionalExtension;
        let body: Option<String> = self
            .db
            .lock()
            .map_err(|_| Error::new("STORAGE", "History unavailable."))?
            .query_row("SELECT body FROM events WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        body.map(|body| {
            serde_json::from_str(&body)
                .map_err(|_| Error::new("STORAGE_CORRUPT", "The captured event is invalid."))
        })
        .transpose()
    }
    pub fn get<T: DeserializeOwned>(&self, collection: &str, id: &str) -> Result<Option<T>, Error> {
        use rusqlite::OptionalExtension;
        let body: Option<String> = self
            .db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Local data unavailable."))?
            .query_row(
                "SELECT body FROM documents WHERE collection=?1 AND id=?2",
                [collection, id],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|body| {
            serde_json::from_str(&body)
                .map_err(|_| Error::new("STORAGE_CORRUPT", "Local data is invalid."))
        })
        .transpose()
    }
    pub fn put<T: Serialize>(&self, collection: &str, id: &str, value: &T) -> Result<(), Error> {
        let body = serde_json::to_string(value)
            .map_err(|_| Error::new("SERIALIZATION", "Cannot encode metadata."))?;
        self.db.lock().map_err(|_|Error::new("STORAGE","Storage lock unavailable."))?.execute("INSERT INTO documents VALUES(?1,?2,?3) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body",params![collection,id,body])?;
        Ok(())
    }
    pub fn delete(&self, collection: &str, id: &str) -> Result<(), Error> {
        self.db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Storage lock unavailable."))?
            .execute(
                "DELETE FROM documents WHERE collection=? AND id=?",
                params![collection, id],
            )?;
        Ok(())
    }
    pub fn event(&self, event: &Event) -> Result<(), Error> {
        let mut event = event.clone();
        let mut body = serde_json::to_string(&event)
            .map_err(|_| Error::new("SERIALIZATION", "Cannot encode observation."))?;
        if body.len() > 1024 * 1024 {
            event.capture = "metadata".into();
            event.before_state = None;
            event.after_state = None;
            event.record = None;
            for change in &mut event.changes {
                change.before = None;
                change.after = None;
            }
            event
                .summary
                .push_str(" Values omitted: event exceeded the 1 MiB capture limit.");
            body = serde_json::to_string(&event)
                .map_err(|_| Error::new("SERIALIZATION", "Cannot encode observation metadata."))?;
        }
        if body.len() > 1024 * 1024 {
            return Err(Error::new(
                "EVENT_LIMIT",
                "Event metadata exceeds 1 MiB. Narrow the watch projection.",
            ));
        }
        self.db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Storage lock unavailable."))?
            .execute(
                "INSERT INTO events VALUES(?1,?2,?3,?4)",
                params![event.id, event.watch_id, event.observed_at, body],
            )?;
        Ok(())
    }
    #[cfg(test)]
    pub fn events(&self, watch_id: Option<String>, limit: u32) -> Result<Vec<Event>, Error> {
        self.event_page(watch_id, limit, 0)
    }
    pub fn event_page(
        &self,
        watch_id: Option<String>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Event>, Error> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Storage lock unavailable."))?;
        let mut stmt=db.prepare("SELECT body FROM events WHERE (?1 IS NULL OR watch_id=?1) ORDER BY observed_at DESC,rowid DESC LIMIT ?2 OFFSET ?3")?;
        let mut rows = stmt.query(params![watch_id, limit.min(1000), offset.min(1000000)])?;
        let mut events = Vec::new();
        let mut bytes = 0usize;
        while let Some(row) = rows.next()? {
            let body: String = row.get(0)?;
            bytes += body.len();
            if bytes > 8 * 1024 * 1024 {
                break;
            }
            events.push(
                serde_json::from_str(&body)
                    .map_err(|_| Error::new("STORAGE_CORRUPT", "Stored event is invalid."))?,
            );
        }
        Ok(events)
    }
    pub fn clear_events(&self, id: Option<String>) -> Result<(), Error> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| Error::new("STORAGE", "History unavailable."))?;
        let tx = db.transaction()?;
        tx.execute("DELETE FROM events WHERE (?1 IS NULL OR watch_id=?1)", [id])?;
        tx.execute("DELETE FROM documents WHERE collection='restores' AND id NOT IN (SELECT id FROM events)",[])?;
        tx.commit()?;
        Ok(())
    }
    pub fn history(&self) -> Result<Vec<serde_json::Value>, Error> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Storage lock unavailable."))?;
        let mut stmt =
            db.prepare("SELECT body FROM query_history ORDER BY created_at DESC LIMIT 200")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|s| {
                serde_json::from_str(&s)
                    .map_err(|_| Error::new("STORAGE_CORRUPT", "Invalid query history."))
            })
            .collect()
    }
    pub fn add_history(
        &self,
        id: &str,
        connection_id: &str,
        body: &serde_json::Value,
    ) -> Result<(), Error> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Storage lock unavailable."))?;
        db.execute(
            "INSERT INTO query_history VALUES(?1,?2,?3,?4)",
            params![
                id,
                connection_id,
                chrono::Utc::now().to_rfc3339(),
                body.to_string()
            ],
        )?;
        db.execute("DELETE FROM query_history WHERE rowid NOT IN(SELECT rowid FROM query_history ORDER BY created_at DESC LIMIT 1000)",[])?;
        loop {
            let bytes: u64 = db.query_row(
                "SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM query_history",
                [],
                |r| r.get(0),
            )?;
            if bytes <= 32 * 1024 * 1024 {
                break;
            }
            db.execute("DELETE FROM query_history WHERE rowid IN(SELECT rowid FROM query_history ORDER BY created_at LIMIT 100)",[])?;
        }
        Ok(())
    }
    pub fn clear_history(&self) -> Result<(), Error> {
        self.db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Storage lock unavailable."))?
            .execute("DELETE FROM query_history", [])?;
        Ok(())
    }
    pub fn retain(&self, days: u64, max_events: u64, max_bytes: u64) -> Result<(), Error> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| Error::new("STORAGE", "Storage lock unavailable."))?;
        let tx = db.transaction()?;
        let cutoff =
            (chrono::Utc::now() - chrono::Duration::days(days.min(3650) as i64)).to_rfc3339();
        tx.execute("DELETE FROM events WHERE observed_at<?", [&cutoff])?;
        tx.execute("DELETE FROM query_history WHERE created_at<?", [&cutoff])?;
        tx.execute("DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY watch_id ORDER BY observed_at DESC,rowid DESC) AS n FROM events) WHERE n>?1)",[max_events.min(100_000)])?;
        loop {
            let size: u64 = tx.query_row(
                "SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM events",
                [],
                |r| r.get(0),
            )?;
            if size <= max_bytes {
                break;
            }
            tx.execute("DELETE FROM events WHERE rowid IN(SELECT rowid FROM events ORDER BY observed_at LIMIT 100)",[])?;
        }
        tx.execute("DELETE FROM documents WHERE collection='restores' AND id NOT IN (SELECT id FROM events)",[])?;
        tx.commit()?;
        Ok(())
    }
}
