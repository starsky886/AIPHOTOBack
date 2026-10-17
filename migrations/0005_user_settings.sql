CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, key));
CREATE INDEX IF NOT EXISTS idx_user_settings_updated ON user_settings(user_id, updated_at);
