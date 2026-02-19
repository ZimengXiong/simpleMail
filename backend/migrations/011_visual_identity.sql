ALTER TABLE incoming_connectors ADD COLUMN IF NOT EXISTS visual_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS visual_config jsonb NOT NULL DEFAULT '{}'::jsonb;
