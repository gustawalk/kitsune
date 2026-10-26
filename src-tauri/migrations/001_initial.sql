CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(collection,id));
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, observed_at TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_watch_time ON events(watch_id,observed_at);
CREATE TABLE IF NOT EXISTS query_history (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
PRAGMA user_version=1;
