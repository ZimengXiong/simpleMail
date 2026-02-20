import assert from 'node:assert/strict';
import { pool } from '../../db/pool.js';
import {
  applyThreadMessageActions,
  getMailboxState,
  requestSyncCancellation,
  setSyncState,
} from '../imap.js';

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

await test('setSyncState falls back cleanly when sync_states schema is unavailable', async () => {
  await withMockedQueries(
    [
      {
        error: Object.assign(new Error('missing table'), { code: '42P01' }),
        check: (call) => {
          assert.match(call.text, /FROM information_schema\.columns/);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /UPDATE sync_states/);
          assert.deepEqual(call.params, ['connector-a', 'INBOX']);
        },
      },
    ],
    async () => {
      await setSyncState('connector-a', 'INBOX', { status: 'syncing' });
    },
  );
});

await test('getMailboxState reads status/progress columns when available', async () => {
  await withMockedQueries(
    [
      {
        rows: [
          { column_name: 'incoming_connector_id' },
          { column_name: 'mailbox' },
          { column_name: 'updated_at' },
          { column_name: 'uidvalidity' },
          { column_name: 'last_seen_uid' },
          { column_name: 'highest_uid' },
          { column_name: 'last_full_reconcile_at' },
          { column_name: 'modseq' },
          { column_name: 'status' },
          { column_name: 'sync_started_at' },
          { column_name: 'sync_completed_at' },
          { column_name: 'sync_error' },
          { column_name: 'sync_progress' },
        ],
        check: (call) => {
          assert.match(call.text, /FROM information_schema\.columns/);
        },
      },
      {
        rows: [{
          lastSeenUid: '12',
          highestUid: '44',
          uidvalidity: '999',
          modseq: '12345',
          lastFullReconcileAt: '2026-02-20T01:00:00.000Z',
          status: 'queued',
          syncStartedAt: '2026-02-20T01:01:00.000Z',
          syncCompletedAt: null,
          syncError: null,
          syncProgress: { inserted: 10 },
        }],
        check: (call) => {
          assert.match(call.text, /SELECT .*status/);
          assert.deepEqual(call.params, ['connector-a', 'INBOX']);
        },
      },
    ],
    async () => {
      const state = await getMailboxState('connector-a', 'INBOX');
      assert.equal(state.lastSeenUid, 12);
      assert.equal(state.highestUid, 44);
      assert.equal(state.mailboxUidValidity, '999');
      assert.equal(state.modseq, '12345');
      assert.equal(state.status, 'queued');
      assert.equal(state.syncStartedAt, '2026-02-20T01:01:00.000Z');
      assert.deepEqual(state.syncProgress, { inserted: 10 });
    },
  );
});

await test('setSyncState persists queued/cancel metadata using cached schema columns', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.match(call.text, /UPDATE sync_states/);
          assert.match(call.text, /status = \$3/);
          assert.match(call.text, /sync_error = \$4/);
          assert.match(call.text, /sync_progress = \$5::jsonb/);
          assert.match(call.text, /highest_uid = \$6/);
          assert.match(call.text, /modseq = \$7/);
          assert.deepEqual(call.params, [
            'connector-a',
            'INBOX',
            'cancel_requested',
            'cancel requested by user',
            JSON.stringify({ inserted: 3 }),
            88,
            '222',
          ]);
        },
      },
    ],
    async () => {
      await setSyncState('connector-a', 'INBOX', {
        status: 'cancel_requested',
        syncError: 'cancel requested by user',
        syncProgress: { inserted: 3 } as any,
        highestUid: 88,
        modseq: '222',
      });
    },
  );
});

await test('applyThreadMessageActions scopes thread updates to source connector', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ thread_id: 'thread-1', incoming_connector_id: 'connector-scope' }],
        check: (call) => {
          assert.match(call.text, /SELECT m\.thread_id,/);
          assert.deepEqual(call.params, ['msg-1', 'user-1']);
        },
      },
      {
        rows: [{ id: 'msg-1', incoming_connector_id: 'connector-scope', folder_path: 'INBOX', uid: 11 }],
        check: (call) => {
          assert.match(call.text, /AND m\.incoming_connector_id = \$3/);
          assert.deepEqual(call.params, ['thread-1', 'user-1', 'connector-scope']);
        },
      },
    ],
    async () => {
      await applyThreadMessageActions('user-1', 'msg-1', {});
    },
  );
});

await test('applyThreadMessageActions rejects missing source thread context', async () => {
  await withMockedQueries(
    [
      { rows: [] },
    ],
    async () => {
      await assert.rejects(
        applyThreadMessageActions('user-1', 'missing-msg', {}),
        /Message not found/,
      );
    },
  );
});

await test('requestSyncCancellation normalizes Gmail IMAP mailboxes and emits cancellation event', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'connector-gmail-imap', user_id: 'user-1', provider: 'imap', sync_settings: { gmailImap: true } }],
        check: (call) => {
          assert.equal(call.text, 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['connector-gmail-imap', 'user-1']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /INSERT INTO sync_states/);
          assert.deepEqual(call.params, ['connector-gmail-imap', 'SPAM']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /UPDATE sync_states/);
          assert.match(call.text, /status = \$3/);
          assert.match(call.text, /sync_error = \$4/);
          assert.deepEqual(call.params, [
            'connector-gmail-imap',
            'SPAM',
            'cancel_requested',
            'cancel requested by user',
          ]);
        },
      },
      {
        rows: [{ id: '0', user_id: null }],
        check: (call) => {
          assert.match(call.text, /INSERT INTO sync_events/);
          assert.equal(call.params[0], 'connector-gmail-imap');
          assert.equal(call.params[1], 'sync_cancel_requested');
          assert.equal(JSON.parse(String(call.params[2])).mailbox, 'SPAM');
        },
      },
    ],
    async () => {
      const result = await requestSyncCancellation('user-1', 'connector-gmail-imap', '[Google Mail]/Junk');
      assert.deepEqual(result, {
        status: 'cancel_requested',
        connectorId: 'connector-gmail-imap',
        mailbox: 'SPAM',
      });
    },
  );
});

await test('requestSyncCancellation fails for unknown connector ownership', async () => {
  await withMockedQueries(
    [
      {
        rows: [],
      },
    ],
    async () => {
      await assert.rejects(
        requestSyncCancellation('user-1', 'connector-missing', 'INBOX'),
        /not found/,
      );
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
