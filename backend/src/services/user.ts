import { randomBytes, createHash } from 'node:crypto';
import { query } from '../db/pool.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface NewUserPayload {
  email: string;
  name: string;
  token?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  tokenPrefix: string;
  token?: string;
}

export interface ResolvedUser {
  id: string;
  email: string;
  name: string;
  tokenPrefix: string;
}

export const createUser = async (payload: NewUserPayload): Promise<UserRecord> => {
  const email = String(payload.email).trim().toLowerCase();
  const name = String(payload.name).trim();
  const token = payload.token?.trim() || randomBytes(24).toString('base64url');
  const tokenPrefix = token.slice(0, 8);

  const result = await query<{ id: string; email: string; name: string; token_prefix: string }>(
    `INSERT INTO users (email, name, token_hash, token_prefix)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           token_hash = EXCLUDED.token_hash,
           token_prefix = EXCLUDED.token_prefix,
           updated_at = NOW()
     RETURNING id, email, name, token_prefix`,
    [email, name, hashToken(token), tokenPrefix],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create or update user');
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    tokenPrefix: row.token_prefix,
    token,
  };
};

export const getUserByToken = async (token: string): Promise<ResolvedUser | null> => {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const result = await query<{ id: string; email: string; name: string; token_prefix: string }>(
    'SELECT id, email, name, token_prefix FROM users WHERE token_hash = $1',
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    tokenPrefix: row.token_prefix,
  };
};

export const getUserById = async (userId: string): Promise<ResolvedUser | null> => {
  const result = await query<{ id: string; email: string; name: string; token_prefix: string }>(
    'SELECT id, email, name, token_prefix FROM users WHERE id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    tokenPrefix: row.token_prefix,
  };
};
