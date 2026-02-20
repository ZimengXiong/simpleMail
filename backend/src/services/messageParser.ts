import { blobStore } from '../storage/seaweedS3BlobStore.js';
import PostalMime from 'postal-mime';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import { scanBuffer } from './clamav.js';
import { emitSyncEvent } from './imapEvents.js';
import { getAttachmentScanDecision } from './scanPolicy.js';
import { enqueueAttachmentScan } from './queue.js';
import { env } from '../config/env.js';

const sanitizeFilename = (value?: string | null) => value?.replace(/[/\\]/g, '_') ?? 'attachment';

const isLikelyTextAttachment = (mimeType: string, filename: string): boolean => {
  const normalizedMime = mimeType.toLowerCase();
  if (normalizedMime.startsWith('text/')) return true;
  if (normalizedMime === 'application/json' || normalizedMime === 'application/xml') return true;

  const extension = filename.toLowerCase().split('.').pop();
  if (!extension) return false;

  return new Set([
    'txt',
    'md',
    'json',
    'xml',
    'csv',
    'log',
    'yaml',
    'yml',
    'ini',
    'cfg',
    'env',
    'conf',
    'js',
    'ts',
    'tsx',
    'jsx',
    'html',
    'htm',
    'css',
    'scss',
    'less',
    'sql',
    'sqls',
  ]).has(extension);
};

const extractAttachmentSearchText = (filename: string, mimeType: string, data: Buffer): string | null => {
  if (!isLikelyTextAttachment(mimeType, filename)) {
    return null;
  }
  if (data.length > env.scan.maxAttachmentBytesForScan) {
    return null;
  }

  const decoded = data.toString('utf8');
  if (!decoded.trim()) {
    return null;
  }
  return decoded.replace(/<[^>]*>/g, ' ');
};

const headersToObject = (headers: Array<{ key: string; value: string }> | undefined) => {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  for (const header of headers) {
    normalized[header.key.toLowerCase()] = header.value;
  }
  return normalized;
};

export interface ParsedMessageSummary {
  attachmentCount: number;
}

const parseAddress = (value: any): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry: any) => `${entry.name ?? ''} ${entry.address ?? entry}`.trim())
      .filter(Boolean)
      .join(', ');
  }
  return `${value.name ?? ''} ${value.address ?? value}`.trim() || null;
};

export const parseAndPersistMessage = async (
  messageId: string,
  source: Buffer,
): Promise<ParsedMessageSummary> => {
  const parser = new PostalMime();
  const parsed = await parser.parse(source);

  const text = parsed.text ?? null;
  const html = parsed.html ?? null;
  const subject = parsed.subject || null;
  const fromHeader = parseAddress(parsed.from) || null;
  const toHeader = parseAddress(parsed.to) || null;
  const messageIdHeader = parsed.messageId || null;
  const inReplyTo = parsed.inReplyTo || null;
  const references = parsed.references || null;

  await query(
    `UPDATE messages
       SET body_text = $2,
           body_html = $3,
           subject = COALESCE($4, subject),
           from_header = COALESCE($5, from_header),
           to_header = COALESCE($6, to_header),
           message_id = COALESCE($7, message_id),
           in_reply_to = $8,
           references_header = $9,
           snippet = $10,
           search_snippet = $10,
           raw_headers = $11::jsonb,
           search_vector = NULL
     WHERE id = $1`,
    [
      messageId,
      text,
      html,
      subject,
      fromHeader,
      toHeader,
      messageIdHeader,
      inReplyTo,
      references,
      (text ?? '').slice(0, 500),
      JSON.stringify(headersToObject(parsed.headers ?? [])),
    ],
  );

  let attachmentCount = 0;
  const attachments = (parsed.attachments ?? []) as Array<{
    filename?: string;
    mimeType?: string;
    content: string | ArrayBuffer | Buffer;
    contentType?: string;
    encoding?: string;
    disposition?: string;
    contentId?: string;
  }>;

  const existingAttachments = await query<{ blob_key: string | null }>(
    `SELECT blob_key
       FROM attachments
      WHERE message_id = $1`,
    [messageId],
  );

  if (existingAttachments.rows.length > 0) {
    await query('DELETE FROM attachments WHERE message_id = $1', [messageId]);
    await Promise.allSettled(
      existingAttachments.rows
        .map((row) => row.blob_key)
        .filter((value): value is string => Boolean(value))
        .map((blobKey) => blobStore.deleteObject(blobKey)),
    );
  }

  for (const attachment of attachments) {
    attachmentCount += 1;
    const attachmentBuffer = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : typeof attachment.content === 'string'
        ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
        : Buffer.from(new Uint8Array(attachment.content));

    const filename = sanitizeFilename(attachment.filename);
    const contentType = attachment.mimeType || attachment.contentType || 'application/octet-stream';
    const attachmentKey = `attachments/${messageId}/${uuidv4()}-${filename}`;
    await blobStore.putObject(attachmentKey, attachmentBuffer, contentType);
    const searchText = extractAttachmentSearchText(filename, contentType, attachmentBuffer);

    const decision = getAttachmentScanDecision(attachmentBuffer.length);
    let scanStatus = decision.status;
    let scanResult = decision.verdictHint ?? null;
    if (decision.disposition === 'inline') {
      try {
        const result = await scanBuffer(attachmentBuffer);
        scanStatus = result.safe ? 'clean' : 'infected';
        scanResult = result.verdict;
      } catch (error) {
        scanStatus = 'error';
        scanResult = String(error);
      }
    }

    const attachmentInsert = await query<{ id: string }>(
      `INSERT INTO attachments
       (message_id, filename, content_type, size_bytes, blob_key, is_inline, scan_status, scan_result, search_text, content_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        messageId,
        attachment.filename ?? 'attachment',
        contentType,
        attachmentBuffer.length,
        attachmentKey,
        attachment.disposition === 'inline' || Boolean(attachment.contentId),
        scanStatus,
        scanResult,
        searchText,
        attachment.contentId || null,
      ],
    );

    const attachmentId = attachmentInsert.rows[0]?.id;
    if (decision.disposition === 'queued' && attachmentId) {
      await enqueueAttachmentScan(messageId, attachmentId);
    }
  }

  const incomingConnectorId = await getConnectorFromMessage(messageId);
  if (incomingConnectorId) {
    await emitSyncEvent(incomingConnectorId, 'message_parsed', {
      messageId,
      attachmentCount,
      fileCount: attachments.length,
    });
  }

  return { attachmentCount };
};

const getConnectorFromMessage = async (messageId: string) => {
  const result = await query<{ incoming_connector_id: string }>(
    'SELECT incoming_connector_id FROM messages WHERE id = $1',
    [messageId],
  );
  return result.rows[0]?.incoming_connector_id;
};
