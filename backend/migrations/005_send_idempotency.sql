CREATE TABLE IF NOT EXISTS send_idempotency (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  result jsonb,
  error_message text,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_send_idempotency_status
  ON send_idempotency (status);
CREATE INDEX IF NOT EXISTS idx_send_idempotency_expires_at
  ON send_idempotency (expires_at);
CREATE INDEX IF NOT EXISTS idx_send_idempotency_identity
  ON send_idempotency (identity_id);

-- Best effort retention cleanup for completed/failed rows.
CREATE OR REPLACE FUNCTION cleanup_expired_send_idempotency()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM send_idempotency WHERE expires_at < NOW();
$$;
