ALTER TABLE IF EXISTS incoming_connectors
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE IF EXISTS outgoing_connectors
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE IF EXISTS identities
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE IF EXISTS rules
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE IF EXISTS push_subscriptions
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE IF EXISTS oauth_states
  ADD COLUMN IF NOT EXISTS user_id uuid;

ALTER TABLE IF EXISTS oauth_states
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE IF EXISTS oauth_states
  ADD CONSTRAINT oauth_states_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_oauth_states_user_id ON oauth_states (user_id);
