ALTER TABLE sync_states
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS sync_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_error text,
  ADD COLUMN IF NOT EXISTS sync_progress jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_sync_states_status ON sync_states (incoming_connector_id, status);
