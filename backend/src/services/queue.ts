import { makeWorkerUtils, WorkerUtils } from 'graphile-worker';
import { env } from '../config/env.js';

let queue: WorkerUtils | null = null;

export const createQueue = async () => {
  if (queue) return queue;
  queue = await makeWorkerUtils({
    connectionString: env.databaseUrl,
  });
  return queue;
};

export const enqueueSync = async (userId: string, connectorId: string, mailbox = 'INBOX') => {
  const q = await createQueue();
  await q.addJob(
    'syncIncomingConnector',
    { userId, connectorId, mailbox },
    {
      maxAttempts: 5,
      jobKey: `sync:${connectorId}:${mailbox}`,
      jobKeyMode: 'unsafe_dedupe',
    },
  );
};

export const enqueueSend = async (payload: {
  userId: string;
  identityId: string;
  idempotencyKey: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: Array<{ filename: string; contentType: string; contentBase64: string; inline?: boolean; contentId?: string }>;
}) => {
  const q = await createQueue();
  await q.addJob(
    'sendEmail',
    payload,
    {
      maxAttempts: 3,
      jobKey: `send:${payload.userId}:${payload.idempotencyKey}`,
      jobKeyMode: 'unsafe_dedupe',
    },
  );
};

export const enqueueAttachmentScan = async (messageId: string, attachmentId: string) => {
  const q = await createQueue();
  await q.addJob(
    'scanAttachment',
    { messageId, attachmentId },
    {
      maxAttempts: 2,
      jobKey: `scan:${messageId}:${attachmentId}`,
      jobKeyMode: 'unsafe_dedupe',
    },
  );
};
