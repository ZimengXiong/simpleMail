import { Pool } from 'pg';
import { env } from '../config/env.js';

const connectionString = env.databaseUrl;

export const pool = new Pool({
  connectionString,
  max: 25,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

import type { QueryResultRow } from 'pg';

export const query = <T extends QueryResultRow = QueryResultRow>(text: string, params: any[] = []): Promise<{ rows: T[] }> => {
  return pool.query<T>(text, params) as unknown as Promise<{ rows: T[] }>;
};

export const now = () => new Date().toISOString();
