ALTER TABLE IF EXISTS oauth_states
  ALTER COLUMN connector_id DROP NOT NULL;

ALTER TABLE IF EXISTS oauth_states
  ADD COLUMN IF NOT EXISTS connector_payload jsonb;
