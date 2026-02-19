ALTER TABLE send_idempotency
  ADD COLUMN IF NOT EXISTS request_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

