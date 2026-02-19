import { run } from 'graphile-worker';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { reapStaleSyncStates, runIdleWatchdog } from '../services/imap.js';
import { renewExpiringGmailPushWatches } from '../services/gmailPush.js';
import {
  hydrateGmailMailboxContentTask,
  scanAttachmentTask,
  sendEmailTask,
  syncIncomingConnectorTask,
} from './taskHandlers.js';

const taskList: Record<string, any> = {
  syncIncomingConnector: syncIncomingConnectorTask,
  hydrateGmailMailboxContent: hydrateGmailMailboxContentTask,
  sendEmail: sendEmailTask,
  scanAttachment: scanAttachmentTask,
} as const;

const unlockStaleWorkerLocks = async () => {
  const relationCheck = await query<{ rel: string | null }>(
    "SELECT to_regclass('graphile_worker._private_jobs') AS rel"
  );
  if (!relationCheck.rows[0]?.rel) {
    return;
  }

  const staleWorkers = await query<{ locked_by: string }>(`
    SELECT DISTINCT locked_by
      FROM graphile_worker._private_jobs
     WHERE locked_by IS NOT NULL
       AND locked_at IS NOT NULL
       AND locked_at < NOW() - INTERVAL '5 minutes'
  `);

  const workerIds = staleWorkers.rows
    .map((row) => row.locked_by)
    .filter((value): value is string => Boolean(value));

  if (workerIds.length === 0) {
    return;
  }

  await query('SELECT graphile_worker.force_unlock_workers($1::text[])', [workerIds]);
  console.warn(`Unlocked ${workerIds.length} stale Graphile worker lock(s)`);
};

const MAINTENANCE_INTERVAL_MS = 30_000;
const GMAIL_PUSH_RENEW_INTERVAL_MS = 5 * 60_000;

const startMaintenanceLoops = () => {
  let running = false;
  let lastGmailPushRenewAt = 0;

  const runMaintenanceTick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const [staleResult, watchdogResult] = await Promise.all([
        reapStaleSyncStates(),
        runIdleWatchdog(),
      ]);

      const nowMs = Date.now();
      let gmailResult: { renewed: number; failed: number; skipped: number } | null = null;
      if ((nowMs - lastGmailPushRenewAt) >= GMAIL_PUSH_RENEW_INTERVAL_MS) {
        lastGmailPushRenewAt = nowMs;
        gmailResult = await renewExpiringGmailPushWatches();
      }

      if ((staleResult.reaped ?? 0) > 0) {
        console.info(`[maintenance] reaped stale sync states: ${staleResult.reaped}`);
      }
      if ((watchdogResult.restarted ?? 0) > 0) {
        console.info(`[maintenance] restarted idle watchers: ${watchdogResult.restarted}`);
      }
      if (gmailResult && (gmailResult.renewed > 0 || gmailResult.failed > 0)) {
        console.info(
          `[maintenance] gmail push renewals: renewed=${gmailResult.renewed} failed=${gmailResult.failed} skipped=${gmailResult.skipped}`,
        );
      }
    } catch (error) {
      console.warn('[maintenance] tick failed', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runMaintenanceTick();
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
  void runMaintenanceTick();

  return () => clearInterval(timer);
};

async function main() {
  const stopMaintenance = startMaintenanceLoops();
  process.on('SIGINT', stopMaintenance);
  process.on('SIGTERM', stopMaintenance);

  try {
    await unlockStaleWorkerLocks();
  } catch (error) {
    console.warn('Failed to unlock stale Graphile worker locks', error);
  }

  await run({
    connectionString: env.databaseUrl,
    taskList,
    concurrency: 5,
    pollInterval: 1000,
    schema: 'graphile_worker',
  });
}

main().catch((err) => {
  console.error('Worker stopped with error', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});
