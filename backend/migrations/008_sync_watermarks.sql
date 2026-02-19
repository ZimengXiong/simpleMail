ALTER TABLE sync_states
  ADD COLUMN IF NOT EXISTS highest_uid bigint,
  ADD COLUMN IF NOT EXISTS last_full_reconcile_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sync_states_reconcile
  ON sync_states (incoming_connector_id, mailbox, last_full_reconcile_at);
