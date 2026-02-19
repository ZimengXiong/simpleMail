import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db/pool.js';

type PgError = {
  code?: string;
  message: string;
};

const isIgnorableDuplicateConstraintError = (error: unknown) => {
  const pgError = error as PgError;
  if (!pgError || !pgError.message) {
    return false;
  }

  if (pgError.code === '42710' && pgError.message.includes('already exists')) {
    return true;
  }

  return false;
};

async function run() {
  const files = readdirSync(path.resolve(process.cwd(), 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.resolve(process.cwd(), 'migrations', file), 'utf8');
    try {
      await pool.query(sql);
    } catch (error) {
      if (isIgnorableDuplicateConstraintError(error)) {
        console.warn(`Skipping duplicate constraint in ${file}`);
        continue;
      }
      throw error;
    }
  }

  console.log('Database migrations applied');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed', err);
  process.exit(1);
});
