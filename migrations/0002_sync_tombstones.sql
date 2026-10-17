CREATE TABLE IF NOT EXISTS deleted_records (id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, deleted_at INTEGER NOT NULL, PRIMARY KEY (id, user_id));
CREATE INDEX IF NOT EXISTS idx_deleted_user_time ON deleted_records(user_id, deleted_at);
