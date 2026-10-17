CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  product_id TEXT NOT NULL,
  transaction_id TEXT,
  original_transaction_id TEXT,
  entitlement TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  environment TEXT,
  raw_event TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, entitlement, original_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user_status ON entitlements(user_id, status, expires_at);
