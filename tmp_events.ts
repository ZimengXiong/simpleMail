import { query } from './backend/src/db/pool.ts';

(async () => {
  const c='dd44c1bd-3894-446e-8b2d-ca083a287813';
  const rows = (await query('SELECT id, event_type, payload, created_at FROM sync_events WHERE incoming_connector_id=$1 ORDER BY id DESC LIMIT 20', [c])).rows;
  console.log(rows);
})();
