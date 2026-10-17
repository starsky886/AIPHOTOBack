CREATE TABLE IF NOT EXISTS entitlement_reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement TEXT NOT NULL,
  kind TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, entitlement, kind, due_at)
);
