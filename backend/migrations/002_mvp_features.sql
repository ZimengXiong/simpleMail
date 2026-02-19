ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_id text,
  ADD COLUMN IF NOT EXISTS in_reply_to text,
  ADD COLUMN IF NOT EXISTS references_header text,
  ADD COLUMN IF NOT EXISTS normalized_subject text,
  ADD COLUMN IF NOT EXISTS raw_headers jsonb,
  ADD COLUMN IF NOT EXISTS search_snippet text;

CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages (message_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages (thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_references ON messages USING gin (to_tsvector('simple', coalesce(references_header, '')));

CREATE TABLE IF NOT EXISTS sync_events (
  id bigserial PRIMARY KEY,
  incoming_connector_id uuid REFERENCES incoming_connectors(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  matching_scope text NOT NULL DEFAULT 'inbound',
  match_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(endpoint)
);

CREATE OR REPLACE FUNCTION rule_ordering_idx() RETURNS trigger AS $$
BEGIN
  IF NEW.execution_order IS NULL THEN
    NEW.execution_order := 0;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rule_ordering_idx_trigger ON rules;
CREATE TRIGGER rule_ordering_idx_trigger
  BEFORE INSERT OR UPDATE ON rules
  FOR EACH ROW
  EXECUTE FUNCTION rule_ordering_idx();
