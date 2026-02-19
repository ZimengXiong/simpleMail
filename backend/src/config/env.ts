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
  port: Number(process.env.PORT ?? '3000'),
  apiAdminToken: process.env.API_ADMIN_TOKEN ?? '',
  databaseUrl: required(process.env.DATABASE_URL, 'DATABASE_URL'),
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/api/oauth/google/callback',
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
    idleIntervalMs: Number(process.env.IDLE_POLL_INTERVAL_MS ?? '45000'),
    useIdle: process.env.SYNC_USE_IDLE !== 'false',
    flagSyncWindow: Number(process.env.SYNC_FLAG_SYNC_WINDOW ?? '256'),
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
