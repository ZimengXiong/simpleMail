ALTER TABLE attachments ADD COLUMN IF NOT EXISTS content_id text;
CREATE INDEX IF NOT EXISTS idx_attachments_content_id ON attachments (content_id);
