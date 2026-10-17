CREATE TABLE IF NOT EXISTS login_attempts (email TEXT PRIMARY KEY, failed_count INTEGER NOT NULL, window_started_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0);
