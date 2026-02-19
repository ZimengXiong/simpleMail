CREATE INDEX IF NOT EXISTS idx_sync_events_connector_id_id ON sync_events (incoming_connector_id, id);
CREATE INDEX IF NOT EXISTS idx_incoming_connectors_user_id_id ON incoming_connectors (user_id, id);
