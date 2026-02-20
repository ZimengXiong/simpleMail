import { createRequire } from 'node:module';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { appendMessageToMailbox } from './imap.js';
import { enqueueSync } from './queue.js';
import { resolveSafeOutboundHost } from './networkGuard.js';
import {
  ensureValidGoogleAccessToken,
  isGoogleTokenExpiringSoon,
} from './googleOAuth.js';
import { gmailApiRequest } from './gmailApi.js';
import { messageIdVariants, normalizeMessageId } from './threadingUtils.js';

const require = createRequire(import.meta.url);
const MailComposer = require('nodemailer/lib/mail-composer/index.js');

type SmtpTlsMode = 'ssl' | 'starttls' | 'none';
const SMTP_HEADER_VALUE_PATTERN = /^[^\r\n]*$/;
const SMTP_ADDRESS_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i;

const normalizeSmtpTlsMode = (value: unknown): SmtpTlsMode | null => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (['ssl', 'tls', 'implicit', 'implicit_tls', 'smtps'].includes(normalized)) {
    return 'ssl';
  }
  if (['starttls', 'start_tls', 'explicit', 'explicit_tls', 'opportunistic_tls'].includes(normalized)) {
    return 'starttls';
  }
  if (['none', 'plain', 'insecure', 'cleartext'].includes(normalized)) {
    return 'none';
  }
  return null;
};

const resolveSmtpTlsMode = (value: unknown): SmtpTlsMode =>
  normalizeSmtpTlsMode(value) ?? 'starttls';

const assertValidPort = (value: unknown, context: string) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${context} port must be an integer between 1 and 65535`);
  }
  return port;
};

const assertAllowedSmtpTlsMode = (tlsMode: SmtpTlsMode) => {
  const insecureAllowed = env.allowInsecureMailTransport || env.nodeEnv === 'development' || env.nodeEnv === 'test';
  if (tlsMode === 'none' && !insecureAllowed) {
    throw new Error('unencrypted SMTP transport is disabled');
  }
};

const getTransport = async (connector: any, authConfig: Record<string, any>) => {
  const auth = authConfig ?? (connector.auth_config ?? {});
  const gmailConnector = connector.provider === 'gmail';
  const useOAuth = (auth.authType ?? 'password') === 'oauth2';
  const host = connector.host || (gmailConnector ? 'smtp.gmail.com' : undefined);
  const port = assertValidPort(
    connector.port || (gmailConnector ? 587 : undefined),
    'SMTP connector',
  );
  const tlsMode = resolveSmtpTlsMode(connector.tls_mode ?? connector.tlsMode);
  assertAllowedSmtpTlsMode(tlsMode);

  if (!host) {
    throw new Error('SMTP connector host is required');
  }
  const resolvedHost = await resolveSafeOutboundHost(String(host), { context: 'outgoing connector host' });
  const tlsServername = net.isIP(resolvedHost.host) > 0 ? undefined : resolvedHost.host;

  const tlsOptions = tlsMode === 'none'
    ? {}
    : {
        tls: {
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
          ...(tlsServername ? { servername: tlsServername } : {}),
        },
      };

  if (gmailConnector && useOAuth) {
    const oauthUser = String(connector.from_address ?? '').trim();
    if (!oauthUser) {
      throw new Error('Gmail OAuth2 SMTP requires a from address');
    }
    if (!auth.refreshToken && !auth.accessToken) {
      throw new Error('Gmail OAuth2 SMTP requires an access token or refresh token');
    }
    return nodemailer.createTransport({
      host: resolvedHost.address,
      port,
      secure: tlsMode === 'ssl',
      requireTLS: tlsMode === 'starttls',
      ignoreTLS: tlsMode === 'none',
      ...tlsOptions,
      auth: {
        type: 'OAuth2',
        user: oauthUser,
        clientId: auth.oauthClientId,
        clientSecret: auth.oauthClientSecret,
        refreshToken: auth.refreshToken,
        accessToken: auth.accessToken,
      },
    } as any);
  }

  const username = String(auth.username ?? '').trim();
  const password = String(auth.password ?? '');
  if (!username || !password) {
    throw new Error('SMTP username and password are required');
  }

  return nodemailer.createTransport({
    host: resolvedHost.address,
    port,
    secure: tlsMode === 'ssl',
    requireTLS: tlsMode === 'starttls',
    ignoreTLS: tlsMode === 'none',
    ...tlsOptions,
    auth: {
      user: username,
      pass: password,
    },
  } as any);
};

export const verifyOutgoingConnectorCredentials = async (input: {
  provider: string;
  fromAddress: string;
  host?: string | null;
  port?: number | null;
  tlsMode?: string | null;
  authType?: string | null;
  authConfig?: Record<string, any> | null;
}) => {
  const provider = String(input.provider || '').trim().toLowerCase();
  const authConfig: Record<string, any> = {
    authType: input.authType ?? input.authConfig?.authType ?? 'password',
    ...(input.authConfig ?? {}),
  };
  const authType = String(authConfig.authType ?? 'password').toLowerCase();

  if (authType === 'oauth2' && provider !== 'gmail') {
    throw new Error('oauth2 outgoing auth is currently only supported for provider=gmail');
  }

  if (authType !== 'oauth2') {
    const username = String(authConfig.username ?? '').trim();
    const password = String(authConfig.password ?? '');
    if (!username || !password) {
      throw new Error('SMTP username and password are required');
    }
  }

  const connector = {
    provider,
    from_address: String(input.fromAddress || '').trim(),
    host: input.host ?? null,
    port: input.port ?? null,
    tls_mode: input.tlsMode ?? 'starttls',
  };

  const transport = await getTransport(connector, authConfig);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
};

export const isRecoverableSmtpError = (error: unknown) => {
  const asError = error as { responseCode?: number; code?: string; command?: string };
  const message = String(error).toLowerCase();
  if (asError.responseCode === 421 || asError.responseCode === 422 || asError.responseCode === 450 || asError.responseCode === 451 || asError.responseCode === 452 || asError.responseCode === 454) {
    return true;
  }
  if (asError.code === 'ECONNRESET' || asError.code === 'ETIMEDOUT' || asError.code === 'ECONNREFUSED' || asError.code === 'EAI_AGAIN') {
    return true;
  }
  return (
    message.includes('connection timed out') ||
    message.includes('rate limit') ||
    message.includes('temporary')
  );
};

const isFatalOAuthRefreshError = (error: unknown) => {
  const message = String(error).toLowerCase();
  return (
    message.includes('invalid_grant') ||
    message.includes('oauth2 error') ||
    message.includes('invalid client') ||
    message.includes('bad access token') ||
    message.includes('user revoked')
  );
};

const isRecoverableOauth2Error = (error: unknown) => {
  const message = String(error).toLowerCase();
  return (
    message.includes('oauth') ||
    message.includes('token') ||
    message.includes('authentication') ||
    message.includes('invalid credentials') ||
    message.includes('invalid token') ||
    message.includes('invalid_grant') ||
    message.includes('login')
  );
};

const extractNormalizedMessageIds = (value?: string | null): string[] => {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  const angleTokens = trimmed.match(/<[^>\s]+>/g) ?? [];
  const candidates = angleTokens.length > 0 ? angleTokens : trimmed.split(/\s+/);

  const dedupe = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeMessageId(candidate);
    if (normalized) {
      dedupe.add(normalized);
    }
  }
  return Array.from(dedupe);
};

const normalizeMessageIdHeader = (value?: string | null): string | undefined => {
  const [first] = extractNormalizedMessageIds(value);
  return first ? `<${first}>` : undefined;
};

const normalizeReferencesHeader = (value?: string | null): string | undefined => {
  const parts = extractNormalizedMessageIds(value);
  if (parts.length === 0) return undefined;
  return parts.map((part) => `<${part}>`).join(' ');
};

const ENVELOPE_EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}/ig;

export const parseEnvelopeRecipients = (value: string | undefined, extra: string[] = []) => {
  const rawEntries = [
    value ?? '',
    ...extra,
  ]
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);

  const dedupe = new Set<string>();
  const recipients: string[] = [];
  const normalizedInput = rawEntries
    .join(',')
    .replace(/[\r\n\0]/g, ' ')
    .slice(0, 200_000);
  const matches = normalizedInput.match(ENVELOPE_EMAIL_PATTERN) ?? [];

  for (const candidate of matches) {
    const normalized = candidate.trim().toLowerCase();
    if (!normalized || dedupe.has(normalized)) {
      continue;
    }
    dedupe.add(normalized);
    recipients.push(normalized);
  }

  return recipients;
};

const normalizeHeaderText = (value: unknown, fallback = '') => {
  const normalized = String(value ?? fallback)
    .replace(/[\r\n\0]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized;
};

const normalizeSingleEmailAddress = (value: unknown, context: string) => {
  const normalized = normalizeHeaderText(value).toLowerCase();
  if (!normalized || !SMTP_ADDRESS_PATTERN.test(normalized)) {
    throw new Error(`${context} is invalid`);
  }
  return normalized;
};

const normalizeReplyToHeader = (value: unknown): string | undefined => {
  const normalized = normalizeHeaderText(value);
  if (!normalized) {
    return undefined;
  }
  if (!SMTP_HEADER_VALUE_PATTERN.test(normalized)) {
    throw new Error('replyTo header is invalid');
  }
  const parsed = parseEnvelopeRecipients(normalized);
  return parsed.length > 0 ? parsed.join(', ') : undefined;
};

export const sendThroughConnector = async (
  userId: string,
  identityId: string,
  payload: {
    to: string;
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyText?: string;
    bodyHtml?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: Array<{
      filename: string;
      contentType: string;
      contentBase64: string;
      inline?: boolean;
      contentId?: string;
    }>;
  },
) => {
  const identityResult = await query<any>(
    'SELECT * FROM identities WHERE id = $1 AND user_id = $2',
    [identityId, userId],
  );
  const identity = identityResult.rows[0];
  if (!identity) throw new Error('Identity not found');

  const outgoingResult = await query<any>(
    `SELECT oc.*
       FROM identities i
       JOIN outgoing_connectors oc ON oc.id = i.outgoing_connector_id
      WHERE i.id = $1
        AND i.user_id = $2
        AND oc.user_id = $2`,
    [identityId, userId],
  );

  const outgoing = outgoingResult.rows[0];
  if (!outgoing) throw new Error('Outgoing connector not found');

  const sentBehavior = outgoing.sent_copy_behavior ?? {};
  let saveSentToConnectorId: string | null =
    sentBehavior.saveSentToIncomingConnectorId || identity.sent_to_incoming_connector_id || null;

  const resolvedAuth =
    outgoing.provider === 'gmail' && (outgoing.auth_config?.authType ?? 'password') === 'oauth2'
      ? await ensureValidGoogleAccessToken('outgoing', outgoing.id, outgoing.auth_config)
      : outgoing.auth_config;

  const attachments = (payload.attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    content: Buffer.from(attachment.contentBase64, 'base64'),
    contentType: attachment.contentType,
    contentDisposition: attachment.inline ? ('inline' as const) : ('attachment' as const),
    cid: attachment.inline ? attachment.contentId : undefined,
  }));

  const fromAddress = {
    name: normalizeHeaderText(identity.display_name),
    address: normalizeSingleEmailAddress(identity.email_address, 'identity email address'),
  };

  const signature = (identity.signature ?? '').trim();
  const replyTo = normalizeReplyToHeader(identity.reply_to || outgoing.from_envelope_defaults?.replyTo);
  const inReplyTo = normalizeMessageIdHeader(payload.inReplyTo);
  const references = normalizeReferencesHeader(payload.references);
  const referenceMessageIds = extractNormalizedMessageIds(references);
  const composedBodyText = payload.bodyText ?? '';
  const composedBodyHtml = payload.bodyHtml ?? '';
  const bodyTextWithSignature = signature
    ? `${composedBodyText}\n\n--\n${signature}`
    : composedBodyText;
  const bodyHtmlWithSignature = signature
    ? `${composedBodyHtml}<br /><br />--<br />${signature.replace(/\r?\n/g, '<br />')}`
    : composedBodyHtml;

  const mail = new MailComposer({
    from: fromAddress,
    to: payload.to,
    cc: payload.cc?.join(','),
    bcc: payload.bcc?.join(','),
    subject: payload.subject,
    replyTo,
    inReplyTo,
    references,
    text: bodyTextWithSignature,
    html: bodyHtmlWithSignature,
    attachments,
  });

  const message = await new Promise<Buffer>((resolve, reject) => {
    mail.compile().build((err: unknown, msg: Buffer | string | null | Uint8Array) => {
      if (err || !msg) {
        reject(err);
        return;
      }
      resolve(Buffer.from(msg));
    });
  });
  const rawHeaderPreview = message.toString('utf8', 0, Math.min(message.length, 65536));
  const generatedMessageId = normalizeMessageIdHeader(
    rawHeaderPreview.match(/^Message-ID:\s*(.+)$/im)?.[1] ?? undefined,
  ) ?? null;

  let activeAuth = resolvedAuth;
  let attempts = 0;
  const maxAttempts = 4;
  let sentCopyError: string | null = null;
  let gmailApiThreadId: string | null = null;
  const useGmailApiSend = outgoing.provider === 'gmail' && (outgoing.auth_config?.authType ?? 'password') === 'oauth2';
  if (useGmailApiSend) {
    if (inReplyTo) {
      const inReplyVariants = messageIdVariants(inReplyTo);
      const byMessageId = await query<{ gmail_thread_id: string | null }>(
        `SELECT m.gmail_thread_id
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND m.gmail_thread_id IS NOT NULL
            AND LOWER(COALESCE(m.message_id, '')) = ANY($2::text[])
          ORDER BY m.received_at DESC
          LIMIT 1`,
        [userId, inReplyVariants],
      );
      gmailApiThreadId = byMessageId.rows[0]?.gmail_thread_id ?? null;
    }
    if (!gmailApiThreadId && referenceMessageIds.length > 0) {
      const referenceVariants = Array.from(new Set(referenceMessageIds.flatMap((value) => messageIdVariants(value))));
      const byReferences = await query<{ gmail_thread_id: string | null; message_id: string }>(
        `SELECT m.gmail_thread_id,
                LOWER(COALESCE(m.message_id, '')) as message_id
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND m.gmail_thread_id IS NOT NULL
            AND LOWER(COALESCE(m.message_id, '')) = ANY($2::text[])
          ORDER BY m.received_at DESC`,
        [userId, referenceVariants],
      );

      for (let refIdx = referenceMessageIds.length - 1; refIdx >= 0 && !gmailApiThreadId; refIdx -= 1) {
        const variants = new Set(messageIdVariants(referenceMessageIds[refIdx]));
        const match = byReferences.rows.find((row) => variants.has(row.message_id));
        if (match?.gmail_thread_id) {
          gmailApiThreadId = match.gmail_thread_id;
        }
      }
    }
    if (!gmailApiThreadId && payload.threadId) {
      const byLocalThread = await query<{ gmail_thread_id: string | null }>(
        `SELECT m.gmail_thread_id
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND m.thread_id = $2
            AND m.gmail_thread_id IS NOT NULL
          ORDER BY m.received_at DESC
          LIMIT 1`,
        [userId, payload.threadId],
      );
      gmailApiThreadId = byLocalThread.rows[0]?.gmail_thread_id ?? null;
    }
  }
  while (attempts < maxAttempts) {
    attempts += 1;
    const useOauth2 = useGmailApiSend;
    let transport: any = null;
    try {
      if (useOauth2 && isGoogleTokenExpiringSoon(activeAuth as Record<string, any>)) {
        activeAuth = await ensureValidGoogleAccessToken('outgoing', outgoing.id, activeAuth as Record<string, any>, {
          forceRefresh: true,
        });
        outgoing.auth_config = activeAuth;
      }

      if (useGmailApiSend) {
        await gmailApiRequest(
          'outgoing',
          { id: outgoing.id, auth_config: activeAuth },
          '/messages/send',
          {
            method: 'POST',
            body: JSON.stringify({
              raw: message.toString('base64url'),
              ...(gmailApiThreadId ? { threadId: gmailApiThreadId } : {}),
            }),
          },
        );
      } else {
        transport = await getTransport(outgoing, activeAuth ?? {});
        const envelopeRecipients = parseEnvelopeRecipients(payload.to, [
          ...(payload.cc ?? []),
          ...(payload.bcc ?? []),
        ]);
        if (envelopeRecipients.length === 0) {
          throw new Error('at least one recipient is required');
        }
        await transport.sendMail({
          envelope: {
            from: identity.email_address,
            to: envelopeRecipients,
          },
          raw: message,
        });
      }
      break;
    } catch (error) {
      if (!isRecoverableSmtpError(error)) {
        throw error;
      }

      if (isFatalOAuthRefreshError(error)) {
        throw error;
      }

      if (useOauth2 && isRecoverableOauth2Error(error)) {
        if (attempts >= maxAttempts) {
          throw error;
        }
        const refreshedAuth = await ensureValidGoogleAccessToken('outgoing', outgoing.id, activeAuth, { forceRefresh: true });
        activeAuth = refreshedAuth;
        outgoing.auth_config = refreshedAuth;
        continue;
      }
      if (attempts >= maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempts - 1), 60000)));
      continue;
    } finally {
      transport?.close();
    }
  }

  if (useGmailApiSend && !saveSentToConnectorId) {
    const inferredIncoming = await query<{ id: string }>(
      `SELECT id
         FROM incoming_connectors
        WHERE user_id = $1
          AND provider = 'gmail'
          AND lower(email_address) = lower($2)
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId, identity.email_address],
    );
    saveSentToConnectorId = inferredIncoming.rows[0]?.id ?? null;
  }

  if (!useGmailApiSend && (sentBehavior.mode === 'imap_append' || sentBehavior.mode === 'imap_append_preferred')) {
    if (!saveSentToConnectorId) {
      throw new Error('No incoming connector configured for sent-copy append');
    }

    const incomingResult = await query<any>(
      'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2',
      [saveSentToConnectorId, userId],
    );
    const incomingConnector = incomingResult.rows[0];

    if (!incomingConnector) {
      throw new Error('Configured sent-copy incoming connector no longer exists');
    }

    const folder = sentBehavior.mailbox || 'Sent';
    try {
      await appendMessageToMailbox(userId, incomingConnector.id, folder, message);
      try {
        await enqueueSync(userId, incomingConnector.id, incomingConnector.provider === 'gmail' ? 'SENT' : folder);
      } catch {
      }
    } catch (error) {
      sentCopyError = String(error);
    }
  }

  if (useGmailApiSend && saveSentToConnectorId) {
    try {
      await enqueueSync(userId, saveSentToConnectorId, 'SENT');
    } catch {
    }
  }

  return {
    accepted: true,
    messageId: generatedMessageId,
    threadTag: gmailApiThreadId,
    sentCopyError,
  };
};
