import { run } from 'graphile-worker';
import { env } from '../config/env.js';
import {
  scanAttachmentTask,
  sendEmailTask,
  syncIncomingConnectorTask,
} from './taskHandlers.js';

const taskList: Record<string, any> = {
  syncIncomingConnector: syncIncomingConnectorTask,
  sendEmail: sendEmailTask,
  scanAttachment: scanAttachmentTask,
} as const;

async function main() {
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
