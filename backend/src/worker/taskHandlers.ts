import { hydrateGmailMailboxContentBatch, syncIncomingConnector } from '../services/imap.js';
import { sendThroughConnector } from '../services/smtp.js';
import { query } from '../db/pool.js';
import { scanBuffer } from '../services/clamav.js';
import { blobStore } from '../storage/seaweedS3BlobStore.js';
import { getAttachmentScanDecision } from '../services/scanPolicy.js';
import { enqueueGmailHydration } from '../services/queue.js';
import {
  acquireSendClaim,
  finalizeSendFailure,
  finalizeSendSuccess,
  normalizeSendIdempotencyKey,
} from '../services/sendIdempotency.js';

export interface SyncIncomingTaskPayload {
  userId: string;
  connectorId: string;
  mailbox?: string;
  gmailHistoryIdHint?: string | null;
}

export const syncIncomingConnectorTask = async (payload: SyncIncomingTaskPayload) => {
  const mailbox = payload.mailbox ?? 'INBOX';
  await syncIncomingConnector(payload.userId, payload.connectorId, mailbox, {
    gmailHistoryIdHint: payload.gmailHistoryIdHint ?? null,
  });
};

export interface GmailHydrationTaskPayload {
  userId: string;
  connectorId: string;
  mailbox: string;
}

export const hydrateGmailMailboxContentTask = async (payload: GmailHydrationTaskPayload) => {
  const result = await hydrateGmailMailboxContentBatch(
    payload.userId,
    payload.connectorId,
    payload.mailbox,
  );
  if (result.remaining > 0) {
    await enqueueGmailHydration(payload.userId, payload.connectorId, payload.mailbox);
  }
  return result;
};

export interface SendTaskPayload {
  userId: string;
  identityId: string;
  idempotencyKey?: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{ filename: string; contentType: string; contentBase64: string; inline?: boolean; contentId?: string }>;
}

const isRetriableSendError = (error: unknown) => {
  const asError = error as { code?: string; errno?: string; responseCode?: number };
  const message = String(error).toLowerCase();
  if (asError.responseCode) {
    const retryableSmtpCodes = new Set([421, 450, 451, 452, 454]);
    if (retryableSmtpCodes.has(asError.responseCode)) {
      return true;
    }
    return false;
  }
  return (
    asError.code === 'ECONNRESET'
    || asError.code === 'ETIMEDOUT'
    || asError.code === 'ENOTFOUND'
    || asError.errno === 'ECONNRESET'
    || asError.errno === 'ETIMEDOUT'
    || asError.errno === 'ENOTFOUND'
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('temporarily')
    || message.includes('rate limit')
    || message.includes('connection')
  );
};

export const sendEmailTask = async (payload: SendTaskPayload) => {
  const idempotencyKey = normalizeSendIdempotencyKey(payload.idempotencyKey);
  const lease = await acquireSendClaim(payload.userId, idempotencyKey, payload.identityId);
  if (lease.status === 'succeeded') {
    return lease.result || { accepted: true };
  }
  if (!lease.leaseAcquired) {
    return { status: 'in_flight' };
  }

  let sendResult: Record<string, any>;
  try {
    sendResult = await sendThroughConnector(payload.userId, payload.identityId, {
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      bodyText: payload.bodyText,
      bodyHtml: payload.bodyHtml,
      threadId: payload.threadId,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      attachments: payload.attachments ?? [],
    });
    await finalizeSendSuccess(payload.userId, idempotencyKey, sendResult as Record<string, any>);
  } catch (error) {
    await finalizeSendFailure(payload.userId, idempotencyKey, String(error));
    if (!isRetriableSendError(error)) {
      return { status: 'failed', error: String(error) };
    }
    throw error;
  }

  return sendResult ?? { accepted: true };
};

export interface ScanAttachmentTask {
  messageId: string;
  attachmentId: string;
}

export const scanAttachmentTask = async (payload: ScanAttachmentTask) => {
  const result = await query<{ blob_key: string; size_bytes: number | null; scan_status: string | null }>(
    `SELECT blob_key, size_bytes, scan_status
       FROM attachments
      WHERE id = $1`,
    [payload.attachmentId],
  );
  const attachment = result.rows[0];
  if (!attachment) return;

  const decision = getAttachmentScanDecision(attachment.size_bytes ?? 0);
  if (decision.disposition !== 'queued') {
    if (attachment.scan_status === decision.status) {
      return;
    }
    await query(
      `UPDATE attachments
          SET scan_status = $2, scan_result = $3
        WHERE id = $1`,
      [payload.attachmentId, decision.status, decision.verdictHint],
    );
    return;
  }

  if (attachment.scan_status !== 'pending') {
    if (attachment.scan_status === 'clean' || attachment.scan_status === 'infected') {
      return;
    }
    await query(
      `UPDATE attachments
       SET scan_status = 'pending', scan_result = NULL
       WHERE id = $1`,
      [payload.attachmentId],
    );
  }

  const data = await blobStore.getObject(attachment.blob_key);
  if (!data) {
    await query(
      `UPDATE attachments
       SET scan_status = 'missing', scan_result = 'blob missing'
       WHERE id = $1`,
      [payload.attachmentId],
    );
    return;
  }

  try {
    const scan = await scanBuffer(data);
    await query(
      `UPDATE attachments SET scan_status = $2, scan_result = $3 WHERE id = $1`,
      [payload.attachmentId, scan.safe ? 'clean' : 'infected', scan.verdict],
    );
  } catch (error) {
    await query(
      `UPDATE attachments SET scan_status = 'error', scan_result = $2 WHERE id = $1`,
      [payload.attachmentId, String(error)],
    );
  }
};
