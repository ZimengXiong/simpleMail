import { randomBytes, createHash } from 'node:crypto';
import { query } from '../db/pool.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const TOKEN_CACHE_TTL_MS = 30_000;
const TOKEN_CACHE_MAX = 5_000;

type TokenCacheEntry = {
  expiresAtMs: number;
  user: ResolvedUser | null;
};

const tokenLookupCache = new Map<string, TokenCacheEntry>();

const getCachedTokenLookup = (tokenHash: string): ResolvedUser | null | undefined => {
  const entry = tokenLookupCache.get(tokenHash);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAtMs <= Date.now()) {
    tokenLookupCache.delete(tokenHash);
    return undefined;
  }
  tokenLookupCache.delete(tokenHash);
  tokenLookupCache.set(tokenHash, entry);
  return entry.user;
};

const setCachedTokenLookup = (tokenHash: string, user: ResolvedUser | null) => {
  tokenLookupCache.delete(tokenHash);
  tokenLookupCache.set(tokenHash, {
    expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS,
    user,
  });
  if (tokenLookupCache.size > TOKEN_CACHE_MAX) {
    const oldest = tokenLookupCache.keys().next().value as string | undefined;
    if (oldest) {
      tokenLookupCache.delete(oldest);
    }
  }
};
const normalizeEmail = (email: string) => String(email).trim().toLowerCase();
const normalizeName = (name: string | undefined, email: string) => {
  const normalized = String(name ?? '').trim();
  if (normalized) {
    return normalized;
  }
  return email;
};

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
  const email = normalizeEmail(payload.email);
  const name = normalizeName(payload.name, email);
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

  tokenLookupCache.clear();

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    tokenPrefix: row.token_prefix,
    token,
  };
};

export const upsertUserFromOidc = async (payload: {
  email: string;
  name?: string;
  subject?: string;
}): Promise<ResolvedUser> => {
  const email = normalizeEmail(payload.email);
  if (!email) {
    throw new Error('OIDC email is required');
  }

  const name = normalizeName(payload.name, email);
  const subject = String(payload.subject ?? '').trim();
  const tokenSeed = subject ? `oidc:${email}:${subject}` : `oidc:${email}`;

  const result = await query<{ id: string; email: string; name: string; token_prefix: string }>(
    `INSERT INTO users (email, name, token_hash, token_prefix)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           token_hash = EXCLUDED.token_hash,
           token_prefix = EXCLUDED.token_prefix,
           updated_at = NOW()
     RETURNING id, email, name, token_prefix`,
    [email, name, hashToken(tokenSeed), 'oidc'],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to upsert OIDC user');
  }

  tokenLookupCache.clear();

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    tokenPrefix: row.token_prefix,
  };
};

export const getUserByToken = async (token: string): Promise<ResolvedUser | null> => {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const cached = getCachedTokenLookup(tokenHash);
  if (cached !== undefined) {
    return cached;
  }

  const result = await query<{ id: string; email: string; name: string; token_prefix: string }>(
    'SELECT id, email, name, token_prefix FROM users WHERE token_hash = $1',
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) {
    setCachedTokenLookup(tokenHash, null);
    return null;
  }

  const resolved = {
    id: row.id,
    email: row.email,
    name: row.name,
    tokenPrefix: row.token_prefix,
  };
  setCachedTokenLookup(tokenHash, resolved);
  return resolved;
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
