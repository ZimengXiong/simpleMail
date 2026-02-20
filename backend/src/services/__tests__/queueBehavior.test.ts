import assert from 'node:assert/strict';
import { pool } from '../../db/pool.js';
import {
  createQueue,
  enqueueAttachmentScan,
  enqueueGmailHydration,
  enqueueRulesReplay,
  enqueueSend,
  enqueueSyncWithOptions,
} from '../queue.js';

type QueryCall = {
  text: string;
  params: any[];
};

type QueryStep = {
  rows?: any[];
  error?: Error & { code?: string };
  check?: (call: QueryCall) => void;
};

const withMockedQueries = async (
  steps: QueryStep[],
  fn: () => Promise<void> | void,
) => {
  const originalQuery = pool.query.bind(pool);
  let index = 0;

  (pool as any).query = async (text: string, params: any[] = []) => {
    const step = steps[index];
    const call: QueryCall = { text: String(text), params: Array.isArray(params) ? params : [] };
    if (!step) {
      throw new Error(`Unexpected query #${index + 1}: ${call.text}`);
    }
    index += 1;
    step.check?.(call);
    if (step.error) {
      throw step.error;
    }
    return { rows: step.rows ?? [] };
  };

  try {
    await fn();
    assert.equal(index, steps.length, `Expected ${steps.length} query calls, got ${index}`);
  } finally {
    (pool as any).query = originalQuery;
  }
};

const withMockedDateNow = async (
  nowValue: number,
  fn: () => Promise<void> | void,
) => {
  const originalDateNow = Date.now;
  Date.now = () => nowValue;
  try {
    await fn();
  } finally {
    Date.now = originalDateNow;
  }
};

const withMockedQueueAddJob = async (
  fn: (calls: Array<{ task: string; payload: Record<string, any>; options: Record<string, any> }>) => Promise<void> | void,
) => {
  const queue = await createQueue();
  const originalAddJob = (queue as any).addJob;
  const calls: Array<{ task: string; payload: Record<string, any>; options: Record<string, any> }> = [];

  (queue as any).addJob = async (task: string, payload: Record<string, any>, options: Record<string, any>) => {
    calls.push({ task, payload, options });
  };

  try {
    await fn(calls);
  } finally {
    (queue as any).addJob = originalAddJob;
  }
};

let passed = 0;
let failed = 0;

const test = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${error}`);
  }
};

await test('createQueue caches worker utils instance', async () => {
  const first = await createQueue();
  const second = await createQueue();
  assert.equal(first, second);
});

await test('enqueueSyncWithOptions short-circuits when mailbox already has active sync claim', async () => {
  await withMockedDateNow(1_000_000, async () => {
    await withMockedQueries(
      [
        {
          check: (call) => {
            assert.match(call.text, /DELETE FROM graphile_worker\.jobs/);
            assert.deepEqual(call.params, ['sync:connector-a:INBOX']);
          },
        },
        {
          rows: [{
            status: 'syncing',
            sync_started_at: new Date(990_000).toISOString(),
            updated_at: new Date(995_000).toISOString(),
          }],
          check: (call) => {
            assert.match(call.text, /FROM sync_states/);
            assert.deepEqual(call.params, ['connector-a', 'INBOX']);
          },
        },
      ],
      async () => {
        const enqueued = await enqueueSyncWithOptions('user-a', 'connector-a', 'INBOX');
        assert.equal(enqueued, false);
      },
    );
  });
});

await test('enqueueSyncWithOptions skips enqueue when no active graphile workers are detected', async () => {
  await withMockedDateNow(2_000_000, async () => {
    await withMockedQueries(
      [
        {},
        { rows: [] },
        {
          rows: [{ count: 0 }],
          check: (call) => {
            assert.match(call.text, /graphile_worker\.workers/);
          },
        },
      ],
      async () => {
        const enqueued = await enqueueSyncWithOptions('user-b', 'connector-b', 'INBOX');
        assert.equal(enqueued, false);
      },
    );
  });
});

await test('enqueueSyncWithOptions falls back to lock activity when worker heartbeat tables are unavailable', async () => {
  await withMockedDateNow(3_000_000, async () => {
    await withMockedQueueAddJob(async (calls) => {
      await withMockedQueries(
        [
          {},
          { rows: [] },
          { error: Object.assign(new Error('missing workers table'), { code: '42P01' }) },
          { error: Object.assign(new Error('missing private workers table'), { code: '42P01' }) },
          {
            rows: [{ count: 2 }],
            check: (call) => {
              assert.match(call.text, /graphile_worker\.jobs/);
              assert.match(call.text, /locked_at/);
            },
          },
        ],
        async () => {
          const enqueued = await enqueueSyncWithOptions('user-c', 'connector-c', 'SENT', {
            priority: 'high',
            gmailHistoryIdHint: '12345',
          });
          assert.equal(enqueued, true);
        },
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].task, 'syncIncomingConnector');
      assert.deepEqual(calls[0].payload, {
        userId: 'user-c',
        connectorId: 'connector-c',
        mailbox: 'SENT',
        gmailHistoryIdHint: '12345',
      });
      assert.equal(calls[0].options.priority, -50);
      assert.equal(calls[0].options.jobKey, 'sync:connector-c:SENT');
      assert.equal(calls[0].options.jobKeyMode, 'preserve_run_at');
    });
  });
});

await test('enqueueSend submits high-priority deduped job', async () => {
  await withMockedQueueAddJob(async (calls) => {
    await enqueueSend({
      userId: 'user-1',
      identityId: 'identity-1',
      idempotencyKey: 'idem-1',
      to: 'to@example.com',
      cc: ['cc@example.com'],
      subject: 'Hello',
      bodyText: 'Body',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'sendEmail');
    assert.equal(calls[0].payload.idempotencyKey, 'idem-1');
    assert.equal(calls[0].options.maxAttempts, 3);
    assert.equal(calls[0].options.jobKeyMode, 'unsafe_dedupe');
    assert.equal(calls[0].options.priority, -100);
  });
});

await test('enqueueAttachmentScan creates deduped scan job', async () => {
  await withMockedQueueAddJob(async (calls) => {
    await enqueueAttachmentScan('message-1', 'attachment-1');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'scanAttachment');
    assert.deepEqual(calls[0].payload, {
      messageId: 'message-1',
      attachmentId: 'attachment-1',
    });
    assert.equal(calls[0].options.jobKey, 'scan:message-1:attachment-1');
    assert.equal(calls[0].options.jobKeyMode, 'unsafe_dedupe');
  });
});

await test('enqueueRulesReplay derives stable key with optional rule id', async () => {
  await withMockedQueueAddJob(async (calls) => {
    await enqueueRulesReplay({
      userId: 'user-2',
      incomingConnectorId: 'connector-2',
      ruleId: 'rule-2',
      limit: 50,
      offset: 10,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'runRules');
    assert.equal(calls[0].options.jobKey, 'rules:user-2:connector-2:rule-2');
    assert.equal(calls[0].options.jobKeyMode, 'preserve_run_at');
    assert.equal(calls[0].options.maxAttempts, 1);
  });
});

await test('enqueueGmailHydration uses preserve_run_at keying per connector mailbox', async () => {
  await withMockedQueueAddJob(async (calls) => {
    await enqueueGmailHydration('user-3', 'connector-3', 'INBOX');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'hydrateGmailMailboxContent');
    assert.deepEqual(calls[0].payload, {
      userId: 'user-3',
      connectorId: 'connector-3',
      mailbox: 'INBOX',
    });
    assert.equal(calls[0].options.jobKey, 'gmail-hydrate:connector-3:INBOX');
    assert.equal(calls[0].options.jobKeyMode, 'preserve_run_at');
    assert.equal(calls[0].options.maxAttempts, 5);
  });
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
