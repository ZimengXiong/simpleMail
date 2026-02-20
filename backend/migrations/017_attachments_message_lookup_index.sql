-- Fast attachment existence/lookup checks for message list filters and thread detail.
CREATE INDEX IF NOT EXISTS idx_attachments_message_id
  ON attachments (message_id);

-- Improves deduped attachment listing queries that sort by newest attachment per message.
CREATE INDEX IF NOT EXISTS idx_attachments_message_created_desc
  ON attachments (message_id, created_at DESC, id DESC);
