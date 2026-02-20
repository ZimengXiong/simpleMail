-- Match logical dedupe key used by /api/messages and /api/messages/search.
CREATE INDEX IF NOT EXISTS idx_messages_connector_dedupe_key_received
  ON messages (
    incoming_connector_id,
    (COALESCE(NULLIF(gmail_message_id, ''), LOWER(NULLIF(message_id, '')), id::text)),
    received_at DESC,
    updated_at DESC
  );

-- Speeds per-thread aggregate lookups for paged inbox/search rows.
CREATE INDEX IF NOT EXISTS idx_messages_connector_thread_id
  ON messages (incoming_connector_id, thread_id)
  WHERE thread_id IS NOT NULL;
