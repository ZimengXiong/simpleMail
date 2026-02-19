ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS gmail_message_id text,
  ADD COLUMN IF NOT EXISTS gmail_thread_id text,
  ADD COLUMN IF NOT EXISTS provider_message_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_gmail_message_per_folder
  ON messages (incoming_connector_id, folder_path, gmail_message_id);

CREATE INDEX IF NOT EXISTS idx_messages_gmail_thread
  ON messages (incoming_connector_id, gmail_thread_id);
