ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS folder_path_norm text GENERATED ALWAYS AS (UPPER(folder_path)) STORED,
  ADD COLUMN IF NOT EXISTS logical_message_key text GENERATED ALWAYS AS (COALESCE(gmail_message_id, id::text)) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_connector_folder_norm_received
  ON messages (incoming_connector_id, folder_path_norm, received_at DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_connector_logical_key_received
  ON messages (incoming_connector_id, logical_message_key, received_at DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_folder_norm_received
  ON messages (folder_path_norm, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_labels_label_message
  ON message_labels (label_id, message_id);
