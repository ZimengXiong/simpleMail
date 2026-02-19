import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db/pool.js';

async function run() {
  const files = readdirSync(path.resolve(process.cwd(), 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.resolve(process.cwd(), 'migrations', file), 'utf8');
    await pool.query(sql);
  }

  console.log('Database migrations applied');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed', err);
  process.exit(1);
});
