ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
CREATE TABLE IF NOT EXISTS ai_analyses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_id TEXT,
  model TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_user_created ON ai_analyses(user_id, created_at DESC);
