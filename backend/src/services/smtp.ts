import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';
import { query } from '../db/pool.js';
import { appendMessageToMailbox } from './imap.js';
import { ensureValidGoogleAccessToken } from './googleOAuth.js';

const require = createRequire(import.meta.url);
const MailComposer = require('nodemailer/lib/mail-composer/index.js');

const getTransport = (connector: any, authConfig: Record<string, any>) => {
  const auth = authConfig ?? (connector.auth_config ?? {});
  const gmailConnector = connector.provider === 'gmail';
  const useOAuth = (auth.authType ?? 'password') === 'oauth2';
  const host = connector.host || (gmailConnector ? 'smtp.gmail.com' : undefined);
  const port = Number(
    connector.port || (gmailConnector ? 587 : undefined),
  );

  if (!host) {
    throw new Error('SMTP connector host is required');
  }
  if (!port) {
    throw new Error('SMTP connector port is required');
  }

  if (gmailConnector && useOAuth) {
    return nodemailer.createTransport({
      host,
      port,
      secure: connector.tls_mode === 'ssl',
      requireTLS: connector.tls_mode === 'starttls',
      auth: {
        type: 'OAuth2',
        user: connector.from_address,
        clientId: auth.oauthClientId,
        clientSecret: auth.oauthClientSecret,
        refreshToken: auth.refreshToken,
        accessToken: auth.accessToken,
      },
    });
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: connector.tls_mode === 'ssl',
    requireTLS: connector.tls_mode === 'starttls',
    auth: {
      user: auth.username,
      pass: auth.password,
    },
  });
};

const isRecoverableSmtpError = (error: unknown) => {
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
    `SELECT oc.*, i.from_envelope_defaults
       FROM identities i
       JOIN outgoing_connectors oc ON oc.id = i.outgoing_connector_id
      WHERE i.id = $1
        AND i.user_id = $2
        AND oc.user_id = $2`,
    [identityId, userId],
  );

  const outgoing = outgoingResult.rows[0];
  if (!outgoing) throw new Error('Outgoing connector not found');

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

  const fromAddress = `${identity.display_name} <${identity.email_address}>`;

  const signature = (identity.signature ?? '').trim();
  const replyTo = identity.reply_to || outgoing.from_envelope_defaults?.replyTo;
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

  let activeAuth = resolvedAuth;
  let attempts = 0;
  const maxAttempts = 4;
  while (attempts < maxAttempts) {
    attempts += 1;
    const useOauth2 = outgoing.provider === 'gmail' && (outgoing.auth_config?.authType ?? 'password') === 'oauth2';
    try {
      const transport = getTransport(outgoing, activeAuth ?? {});
      await transport.sendMail({ raw: message });
      break;
    } catch (error) {
      if (!isRecoverableSmtpError(error)) {
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
    }
  }

  const sentBehavior = outgoing.sent_copy_behavior ?? {};
  const saveSentToConnectorId = sentBehavior.saveSentToIncomingConnectorId || identity.sent_to_incoming_connector_id;
  if (sentBehavior.mode === 'imap_append' || sentBehavior.mode === 'imap_append_preferred') {
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
    await appendMessageToMailbox(userId, incomingConnector.id, folder, message);
  }

  return {
    accepted: true,
    messageId: identity.id,
    threadTag: null,
  };
};
