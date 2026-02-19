import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const cwdEnvPath = path.resolve(process.cwd(), '.env');
const repoEnvPath = path.resolve(process.cwd(), '..', '.env');

dotenv.config({ path: cwdEnvPath });
if (repoEnvPath !== cwdEnvPath && fs.existsSync(repoEnvPath)) {
  dotenv.config({ path: repoEnvPath, override: false });
}

const required = (value?: string, name = 'environment variable'): string => {
  if (!value) {
    throw new Error(`Missing required ${name}`);
  }
  return value;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  bootstrapDevUser: process.env.DEV_USER_BOOTSTRAP === 'true',
  devUserEmail: process.env.DEV_USER_EMAIL ?? 'demo@local.test',
  devUserName: process.env.DEV_USER_NAME ?? 'Demo User',
  devUserToken: process.env.DEV_USER_TOKEN ?? '',
  port: Number(process.env.PORT ?? '3000'),
  apiAdminToken: process.env.API_ADMIN_TOKEN ?? '',
  databaseUrl: required(process.env.DATABASE_URL, 'DATABASE_URL'),
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  frontendBaseUrl: process.env.FRONTEND_BASE_URL ?? 'http://localhost:5173',
  oauthCallbackPath: process.env.OAUTH_CALLBACK_PATH ?? '/oauth/callback',
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/api/oauth/google/callback',
  gmailPush: {
    enabled: process.env.GMAIL_PUSH_ENABLED === 'true',
    topicName: process.env.GMAIL_PUSH_TOPIC_NAME ?? '',
    webhookPath: process.env.GMAIL_PUSH_WEBHOOK_PATH ?? '/api/gmail/push',
    webhookAudience: process.env.GMAIL_PUSH_WEBHOOK_AUDIENCE ?? '',
    pushServiceAccountEmail: process.env.GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL ?? '',
  },
  seaweed: {
    endpoint: process.env.SEAWEED_S3_ENDPOINT ?? 'http://seaweed-filer:8333',
    region: process.env.SEAWEED_REGION ?? 'us-east-1',
    bucket: process.env.SEAWEED_BUCKET ?? 'bettermail',
    accessKeyId: process.env.SEAWEED_ACCESS_KEY_ID ?? 'seaweed_admin',
    secretAccessKey: process.env.SEAWEED_SECRET_ACCESS_KEY ?? 'seaweed_admin_secret',
    forcePathStyle: process.env.SEAWEED_FORCE_PATH_STYLE !== 'false',
  },
  sync: {
    defaultMailbox: process.env.DEFAULT_MAILBOX ?? 'INBOX',
    idleIntervalMs: Number(process.env.IDLE_POLL_INTERVAL_MS ?? '15000'),
    useIdle: process.env.SYNC_USE_IDLE !== 'false',
    flagSyncWindow: Number(process.env.SYNC_FLAG_SYNC_WINDOW ?? '256'),
    operationTimeoutMs: Number(process.env.SYNC_OPERATION_TIMEOUT_MS ?? '120000'),
    fullReconcileIntervalMs: Number(process.env.SYNC_FULL_RECONCILE_INTERVAL_MS ?? '86400000'),
    recentReconcileUidWindow: Number(process.env.SYNC_RECENT_RECONCILE_UID_WINDOW ?? '2000'),
    sourceFetchBatchSize: Number(process.env.SYNC_SOURCE_FETCH_BATCH_SIZE ?? '200'),
    syncClaimStaleMs: Number(process.env.SYNC_SYNC_CLAIM_STALE_MS ?? '180000'),
    syncClaimHeartbeatStaleMs: Number(process.env.SYNC_SYNC_CLAIM_HEARTBEAT_STALE_MS ?? '45000'),
    gmailSyncConcurrency: Number(process.env.GMAIL_SYNC_CONCURRENCY ?? '4'),
    gmailBootstrapMetadataOnly: process.env.GMAIL_BOOTSTRAP_METADATA_ONLY !== 'false',
    gmailBootstrapConcurrency: Number(process.env.GMAIL_BOOTSTRAP_CONCURRENCY ?? '10'),
    gmailBackgroundHydrateBatchSize: Number(process.env.GMAIL_BACKGROUND_HYDRATE_BATCH_SIZE ?? '200'),
    gmailBackgroundHydrateConcurrency: Number(process.env.GMAIL_BACKGROUND_HYDRATE_CONCURRENCY ?? '4'),
    syncEventsRetentionDays: Number(process.env.SYNC_EVENTS_RETENTION_DAYS ?? '14'),
    syncEventsPruneBatchSize: Number(process.env.SYNC_EVENTS_PRUNE_BATCH_SIZE ?? '2000'),
    syncEventsPruneMaxBatches: Number(process.env.SYNC_EVENTS_PRUNE_MAX_BATCHES ?? '3'),
    syncEventsPruneIntervalMs: Number(process.env.SYNC_EVENTS_PRUNE_INTERVAL_MS ?? '300000'),
  },
  scan: {
    enabled: process.env.CLAMAV_ENABLED === 'true',
    clamHost: process.env.CLAMAV_HOST ?? 'localhost',
    clamPort: Number(process.env.CLAMAV_PORT ?? '3310'),
    maxAttachmentBytesForScan: Number(process.env.CLAMAV_ATTACHMENT_MAX_BYTES ?? `${1024 * 1024 * 20}`),
    scanOnIngest: process.env.CLAMAV_SCAN_ON_INGEST !== 'false',
  },
  push: {
    enabled: process.env.WEB_PUSH_ENABLED === 'true',
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    email: process.env.VAPID_EMAIL ?? 'mailto:admin@example.com',
  },
};
