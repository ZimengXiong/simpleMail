CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE incoming_connectors ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE outgoing_connectors ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id uuid;

ALTER TABLE incoming_connectors
  ADD CONSTRAINT incoming_connectors_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE outgoing_connectors
  ADD CONSTRAINT outgoing_connectors_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE identities
  ADD CONSTRAINT identities_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE rules
  ADD CONSTRAINT rules_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_incoming_connectors_user_id ON incoming_connectors (user_id);
CREATE INDEX IF NOT EXISTS idx_outgoing_connectors_user_id ON outgoing_connectors (user_id);
CREATE INDEX IF NOT EXISTS idx_identities_user_id ON identities (user_id);
CREATE INDEX IF NOT EXISTS idx_rules_user_id ON rules (user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions (user_id);
