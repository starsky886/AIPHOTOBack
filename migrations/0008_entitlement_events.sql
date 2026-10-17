CREATE TABLE IF NOT EXISTS entitlement_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement TEXT NOT NULL,
  event_type TEXT NOT NULL,
  product_id TEXT,
  transaction_id TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER,
  environment TEXT,
  raw_event TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entitlement_events_user_created ON entitlement_events(user_id, created_at DESC);
