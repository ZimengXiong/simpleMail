import { createHash, randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';

export type SendIdempotencyStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

const STALE_PROCESSING_INTERVAL_SECONDS = 30;
const SEND_IDEMPOTENCY_TTL_HOURS = 24;

export interface SendIdempotencyPayload {
  userId: string;
  identityId: string;
  idempotencyKey?: string;
  requestHash: string;
}

interface SendRequestHashPayload {
  identityId: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    contentBase64?: string;
    inline?: boolean;
    contentId?: string;
  }>;
}

export interface SendIdempotencyRecord {
  userId: string;
  idempotencyKey: string;
  identityId: string;
  requestHash: string;
  status: SendIdempotencyStatus;
  result: Record<string, any> | null;
  errorMessage: string | null;
  attempts: number;
}

const normalizeKey = (value?: string | null) => (value ? String(value).trim() : '');

export const normalizeSendIdempotencyKey = (value?: string) =>
  normalizeKey(value) || randomUUID();

const hashString = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const makeSendRequestHash = (payload: SendRequestHashPayload) => {
  return hashString(
    JSON.stringify({
      identityId: payload.identityId,
      to: payload.to,
      cc: [...(payload.cc ?? [])].sort((left: string, right: string) => left.localeCompare(right)),
      bcc: [...(payload.bcc ?? [])].sort((left: string, right: string) => left.localeCompare(right)),
      subject: payload.subject,
      bodyText: payload.bodyText ?? '',
      bodyHtml: payload.bodyHtml ?? '',
      attachments: (payload.attachments ?? [])
        .map((attachment: {
          filename: string;
          contentType: string;
          contentBase64?: string;
          inline?: boolean;
          contentId?: string;
        }) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.contentBase64?.length ?? 0,
          inline: !!attachment.inline,
          contentId: attachment.contentId ?? '',
        }))
        .sort((left: { filename: string }, right: { filename: string }) =>
          left.filename.localeCompare(right.filename),
        ),
    }),
  );
};

export const findSendIdempotency = async (
  userId: string,
  idempotencyKey: string,
) => {
  const result = await query<SendIdempotencyRecord>(
    `SELECT user_id as \"userId\", idempotency_key as \"idempotencyKey\", identity_id as \"identityId\", request_hash as \"requestHash\", status, result, error_message as \"errorMessage\", attempts
     FROM send_idempotency
    WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  return result.rows[0] ?? null;
};

export const getOrCreateSendIdempotency = async (payload: {
  userId: string;
  identityId: string;
  idempotencyKey: string;
  requestHash: string;
}) => {
  const existing = await findSendIdempotency(payload.userId, payload.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== payload.requestHash) {
      throw new Error('Idempotency key already used with a different send request');
    }
    if (existing.identityId !== payload.identityId) {
      throw new Error('Idempotency key belongs to a different identity');
    }
    return existing;
  }

  const created = await query<SendIdempotencyRecord>(`
    INSERT INTO send_idempotency
      (user_id, idempotency_key, identity_id, request_hash, status, result, error_message, expires_at, updated_at, created_at, attempts)
    VALUES ($1, $2, $3, $4, 'pending', NULL, NULL, NOW() + ($5::int * INTERVAL '1 hour'), NOW(), NOW(), 0)
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
    RETURNING user_id as \"userId\", idempotency_key as \"idempotencyKey\", identity_id as \"identityId\", request_hash as \"requestHash\", status, result, error_message as \"errorMessage\", attempts
  `,
    [payload.userId, payload.idempotencyKey, payload.identityId, payload.requestHash, SEND_IDEMPOTENCY_TTL_HOURS],
  );

  if (created.rows[0]) {
    return created.rows[0];
  }

  return findSendIdempotency(payload.userId, payload.idempotencyKey);
};

export const acquireSendClaim = async (
  userId: string,
  idempotencyKey: string,
  identityId: string,
): Promise<SendIdempotencyRecord> => {
  const acquireResult = await query<SendIdempotencyRecord>(`
    UPDATE send_idempotency
       SET status = 'processing',
           updated_at = NOW(),
           error_message = NULL,
           attempts = attempts + 1
     WHERE user_id = $1
       AND idempotency_key = $2
       AND identity_id = $3
       AND (
         status = 'pending'
         OR status = 'failed'
         OR (status = 'processing' AND updated_at < NOW() - make_interval(secs => $4))
       )
        AND expires_at > NOW()
     RETURNING user_id as \"userId\", idempotency_key as \"idempotencyKey\", identity_id as \"identityId\", request_hash as \"requestHash\", status, result, error_message as \"errorMessage\", attempts
  `, [userId, idempotencyKey, identityId, STALE_PROCESSING_INTERVAL_SECONDS]);

  if (acquireResult.rows[0]) {
    return acquireResult.rows[0];
  }

  const current = await findSendIdempotency(userId, idempotencyKey);
  if (!current) {
    throw new Error('send idempotency row missing');
  }
  return current;
};

export const finalizeSendSuccess = async (
  userId: string,
  idempotencyKey: string,
  resultPayload: Record<string, any>,
) => {
  await query(
    `UPDATE send_idempotency
        SET status = 'succeeded',
            result = $3::jsonb,
            error_message = NULL,
            updated_at = NOW(),
            expires_at = NOW() + ($4::int * INTERVAL '1 hour')
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey, resultPayload, SEND_IDEMPOTENCY_TTL_HOURS],
  );
};

export const finalizeSendFailure = async (
  userId: string,
  idempotencyKey: string,
  errorMessage: string,
) => {
  await query(
    `UPDATE send_idempotency
        SET status = 'failed',
            error_message = $3,
            updated_at = NOW(),
            expires_at = NOW() + ($4::int * INTERVAL '1 hour')
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey, errorMessage, SEND_IDEMPOTENCY_TTL_HOURS],
  );
};
