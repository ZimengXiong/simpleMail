-- Threading-critical indexes for production performance.

-- Subject-based fallback threading: (incoming_connector_id, normalized_subject) with received_at ordering.
CREATE INDEX IF NOT EXISTS idx_messages_connector_normalized_subject
  ON messages (incoming_connector_id, normalized_subject, received_at DESC);

-- Cross-folder gmail_message_id lookup (threading uses connector + gmail_message_id without folder).
CREATE INDEX IF NOT EXISTS idx_messages_connector_gmail_message_id
  ON messages (incoming_connector_id, gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;

-- In-Reply-To / References matching on LOWER(message_id).
CREATE INDEX IF NOT EXISTS idx_messages_lower_message_id
  ON messages (incoming_connector_id, LOWER(COALESCE(message_id, '')));

-- Thread detail page: thread_id ordered by received_at.
CREATE INDEX IF NOT EXISTS idx_messages_thread_received
  ON messages (thread_id, received_at DESC)
  WHERE thread_id IS NOT NULL;
