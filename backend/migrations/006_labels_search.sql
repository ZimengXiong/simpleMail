CREATE TABLE IF NOT EXISTS labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, key)
);

CREATE TABLE IF NOT EXISTS message_labels (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, label_id)
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  query_text text NOT NULL,
  query_ast jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_starred boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS search_text text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_labels_user_id ON labels (user_id);
CREATE INDEX IF NOT EXISTS idx_labels_user_key ON labels (user_id, key);
CREATE INDEX IF NOT EXISTS idx_message_labels_message_id ON message_labels (message_id);
CREATE INDEX IF NOT EXISTS idx_message_labels_label_id ON message_labels (label_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_labels_key_per_user ON labels (user_id, key) WHERE NOT is_archived;
CREATE INDEX IF NOT EXISTS idx_saved_searches_user_id ON saved_searches (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_searches_user_name ON saved_searches (user_id, name);
CREATE INDEX IF NOT EXISTS idx_saved_searches_user_updated_at ON saved_searches (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_search_vector ON attachments USING GIN (search_vector);

INSERT INTO labels (user_id, key, name, is_system)
SELECT
  u.id,
  k.key,
  k.name,
  TRUE
FROM users u
CROSS JOIN (
  VALUES
    ('all', 'All Mail'),
    ('trash', 'Trash'),
    ('spam', 'Spam'),
    ('snoozed', 'Snoozed'),
    ('starred', 'Starred')
) AS k(key, name)
WHERE NOT EXISTS (
  SELECT 1
  FROM labels l
  WHERE l.user_id = u.id AND l.key = k.key
)
ON CONFLICT (user_id, key) DO NOTHING;

INSERT INTO message_labels (message_id, label_id)
SELECT m.id, l.id
FROM messages m
JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
JOIN labels l ON l.user_id = ic.user_id AND l.key = 'all'
ON CONFLICT DO NOTHING;

INSERT INTO message_labels (message_id, label_id)
SELECT m.id, l.id
FROM messages m
JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
JOIN labels l ON l.user_id = ic.user_id AND l.key = 'trash'
WHERE lower(m.folder_path) LIKE '%trash%'
ON CONFLICT DO NOTHING;

INSERT INTO message_labels (message_id, label_id)
SELECT m.id, l.id
FROM messages m
JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
JOIN labels l ON l.user_id = ic.user_id AND l.key = 'spam'
WHERE lower(m.folder_path) LIKE '%spam%'
ON CONFLICT DO NOTHING;

INSERT INTO message_labels (message_id, label_id)
SELECT m.id, l.id
FROM messages m
JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
JOIN labels l ON l.user_id = ic.user_id AND l.key = 'snoozed'
WHERE lower(m.folder_path) LIKE '%snoozed%'
ON CONFLICT DO NOTHING;

INSERT INTO message_labels (message_id, label_id)
SELECT m.id, l.id
FROM messages m
JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
JOIN labels l ON l.user_id = ic.user_id AND l.key = 'starred'
WHERE m.is_starred
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION attachments_search_vector_set() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    to_tsvector('english', coalesce(NEW.search_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attachments_search_vector_trigger ON attachments;
CREATE TRIGGER attachments_search_vector_trigger
  BEFORE INSERT OR UPDATE OF search_text
  ON attachments
  FOR EACH ROW
  EXECUTE FUNCTION attachments_search_vector_set();
