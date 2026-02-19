CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS incoming_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email_address text NOT NULL,
  provider text NOT NULL,
  host text,
  port integer,
  tls boolean NOT NULL DEFAULT true,
  auth_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outgoing_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  provider text NOT NULL,
  from_address text NOT NULL,
  host text,
  port integer,
  tls_mode text NOT NULL DEFAULT 'starttls',
  auth_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  from_envelope_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_copy_behavior jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  email_address text NOT NULL,
  signature text,
  outgoing_connector_id uuid NOT NULL REFERENCES outgoing_connectors(id) ON DELETE RESTRICT,
  sent_to_incoming_connector_id uuid REFERENCES incoming_connectors(id) ON DELETE SET NULL,
  reply_to text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_states (
  incoming_connector_id uuid NOT NULL REFERENCES incoming_connectors(id) ON DELETE CASCADE,
  mailbox text NOT NULL,
  uidvalidity bigint,
  last_seen_uid bigint,
  modseq bigint,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (incoming_connector_id, mailbox)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incoming_connector_id uuid NOT NULL REFERENCES incoming_connectors(id) ON DELETE CASCADE,
  message_id text,
  subject text,
  from_header text,
  to_header text,
  folder_path text NOT NULL,
  raw_blob_key text,
  body_text text,
  body_html text,
  snippet text,
  received_at timestamptz NOT NULL DEFAULT NOW(),
  is_read boolean NOT NULL DEFAULT false,
  is_starred boolean NOT NULL DEFAULT false,
  thread_id uuid,
  flags text[] NOT NULL DEFAULT ARRAY[]::text[],
  search_vector tsvector,
  uid bigint,
  mailbox_uidvalidity bigint,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT messages_uid_key UNIQUE (incoming_connector_id, folder_path, uid)
);

CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text,
  size_bytes bigint,
  blob_key text NOT NULL,
  is_inline boolean NOT NULL DEFAULT false,
  scan_status text NOT NULL DEFAULT 'pending',
  scan_result text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state text PRIMARY KEY,
  connector_id uuid NOT NULL,
  connector_type text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION messages_search_vector_set() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.from_header, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.to_header, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.body_text, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.body_html, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_search_vector_trigger ON messages;
CREATE TRIGGER messages_search_vector_trigger
  BEFORE INSERT OR UPDATE OF subject, from_header, to_header, body_text, body_html
  ON messages
  FOR EACH ROW
  EXECUTE FUNCTION messages_search_vector_set();

CREATE INDEX IF NOT EXISTS idx_messages_search_vector ON messages USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_messages_connector_folder_received ON messages (incoming_connector_id, folder_path, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_subject ON messages (subject);
CREATE INDEX IF NOT EXISTS idx_messages_from_header ON messages (from_header);
