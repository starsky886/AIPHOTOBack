CREATE TABLE IF NOT EXISTS push_tokens (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, token)
);
