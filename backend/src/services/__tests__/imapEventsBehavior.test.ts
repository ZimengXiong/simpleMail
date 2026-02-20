import assert from 'node:assert/strict';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import {
  emitSyncEvent,
  listSyncEvents,
  pruneSyncEvents,
  resetSyncEventStateForTests,
  waitForSyncEventSignal,
} from '../imapEvents.js';

type QueryCall = {
  text: string;
  params: any[];
};

type QueryStep = {
  rows?: any[];
  error?: Error;
  check?: (call: QueryCall) => void;
};

type FakeNotification = {
  channel: string;
  payload?: string;
};

class FakeListenerClient {
  private listeners = new Map<string, Set<(payload: any) => void>>();
  public released = false;
  public listenQueries: string[] = [];

  on(event: string, handler: (payload: any) => void) {
    const set = this.listeners.get(event) ?? new Set<(payload: any) => void>();
    set.add(handler);
    this.listeners.set(event, set);
    return this;
  }

  removeAllListeners(event: string) {
    this.listeners.delete(event);
    return this;
  }

  async query(text: string) {
    this.listenQueries.push(String(text));
    return { rows: [] };
  }

  release(_destroy?: boolean) {
    this.released = true;
  }

  emit(event: string, payload: any) {
    const handlers = this.listeners.get(event);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      handler(payload);
    }
  }
}

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

const withMockedConnect = async (
  connectImpl: () => Promise<FakeListenerClient>,
  fn: (createdClients: FakeListenerClient[]) => Promise<void> | void,
) => {
  const originalConnect = pool.connect.bind(pool);
  const createdClients: FakeListenerClient[] = [];
  (pool as any).connect = async () => {
    const client = await connectImpl();
    createdClients.push(client);
    return client as any;
  };

  try {
    await fn(createdClients);
  } finally {
    (pool as any).connect = originalConnect;
  }
};

let passed = 0;
let failed = 0;

const test = async (name: string, fn: () => Promise<void> | void) => {
  try {
    resetSyncEventStateForTests();
    await fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${error}`);
  } finally {
    resetSyncEventStateForTests();
  }
};

await test('listSyncEvents clamps since/limit inputs and returns rows', async () => {
  await withMockedQueries(
    [
      {
        rows: [{
          id: 21,
          incomingConnectorId: 'connector-1',
          eventType: 'sync_completed',
          payload: { mailbox: 'INBOX' },
          createdAt: '2026-02-20T00:00:00.000Z',
        }],
        check: (call) => {
          assert.match(call.text, /FROM sync_events/);
          assert.deepEqual(call.params, [0, 'user-1', 500]);
        },
      },
    ],
    async () => {
      const rows = await listSyncEvents('user-1', -100, 2000);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 21);
      assert.equal(rows[0].eventType, 'sync_completed');
    },
  );
});

await test('listSyncEvents falls back to default limit when limit is invalid', async () => {
  await withMockedQueries(
    [
      {
        rows: [],
        check: (call) => {
          assert.deepEqual(call.params, [0, 'user-limit', 100]);
        },
      },
    ],
    async () => {
      const rows = await listSyncEvents('user-limit', Number.NaN, Number.NaN);
      assert.deepEqual(rows, []);
    },
  );
});

await test('pruneSyncEvents deletes in batches and stops when final batch is partial', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: '1' }, { id: '2' }],
        check: (call) => {
          assert.match(call.text, /DELETE FROM sync_events/);
          assert.deepEqual(call.params, [7, 2]);
        },
      },
      {
        rows: [{ id: '3' }],
        check: (call) => {
          assert.deepEqual(call.params, [7, 2]);
        },
      },
    ],
    async () => {
      const result = await pruneSyncEvents({
        retentionDays: 7,
        batchSize: 2,
        maxBatches: 5,
      });
      assert.deepEqual(result, { pruned: 3 });
    },
  );
});

await test('pruneSyncEvents sanitizes non-positive inputs to safe defaults', async () => {
  await withMockedQueries(
    [
      {
        rows: [],
        check: (call) => {
          assert.deepEqual(call.params, [14, 2000]);
        },
      },
    ],
    async () => {
      const result = await pruneSyncEvents({
        retentionDays: -1,
        batchSize: 0,
        maxBatches: -5,
      });
      assert.deepEqual(result, { pruned: 0 });
    },
  );
});

await test('waitForSyncEventSignal returns null when listener bootstrap fails', async () => {
  await withMockedConnect(
    async () => {
      throw new Error('connect failed');
    },
    async () => {
      const started = Date.now();
      const signal = await waitForSyncEventSignal('user-bootstrap-fail', 0, 250);
      const elapsed = Date.now() - started;
      assert.equal(signal, null);
      assert.ok(elapsed >= 200, `expected wait to backoff, elapsed=${elapsed}`);
    },
  );
});

await test('waitForSyncEventSignal normalizes non-finite timeout values during bootstrap failure', async () => {
  await withMockedConnect(
    async () => {
      throw new Error('connect failed');
    },
    async () => {
      const started = Date.now();
      const signal = await waitForSyncEventSignal('user-bootstrap-fail-nan', 0, Number.NaN as any);
      const elapsed = Date.now() - started;
      assert.equal(signal, null);
      assert.ok(elapsed >= 900, `expected fallback wait close to 1s, elapsed=${elapsed}`);
    },
  );
});

await test('waitForSyncEventSignal resolves when a newer sync event is emitted', async () => {
  const originalPushEnabled = env.push.enabled;
  env.push.enabled = false;

  await withMockedConnect(
    async () => new FakeListenerClient(),
    async () => {
      const waitPromise = waitForSyncEventSignal('user-live', 7, 5_000);
      await withMockedQueries(
        [
          {
            rows: [{ id: '8', user_id: 'user-live' }],
          },
        ],
        async () => {
          await emitSyncEvent('connector-live', 'sync_info', { mailbox: 'INBOX' });
        },
      );
      const signal = await waitPromise;
      assert.deepEqual(signal, { userId: 'user-live', eventId: 8 });
    },
  );

  env.push.enabled = originalPushEnabled;
});

await test('waitForSyncEventSignal returns the latest signal id newer than since', async () => {
  const originalPushEnabled = env.push.enabled;
  env.push.enabled = false;

  await withMockedConnect(
    async () => new FakeListenerClient(),
    async () => {
      await withMockedQueries(
        [
          { rows: [{ id: '5', user_id: 'user-stale-check' }] },
          { rows: [{ id: '6', user_id: 'user-stale-check' }] },
        ],
        async () => {
          await emitSyncEvent('connector-stale', 'sync_info', { mailbox: 'INBOX' });
          await emitSyncEvent('connector-stale', 'sync_info', { mailbox: 'INBOX' });
        },
      );

      const signal = await waitForSyncEventSignal('user-stale-check', 5, 5_000);
      assert.deepEqual(signal, { userId: 'user-stale-check', eventId: 6 });
    },
  );

  env.push.enabled = originalPushEnabled;
});

await test('emitSyncEvent stores event and waitForSyncEventSignal reads latest in-memory signal immediately', async () => {
  const originalPushEnabled = env.push.enabled;
  env.push.enabled = false;

  await withMockedQueries(
    [
      {
        rows: [{ id: '42', user_id: 'user-signal' }],
        check: (call) => {
          assert.match(call.text, /INSERT INTO sync_events/);
          assert.equal(call.params[0], 'connector-signal');
          assert.equal(call.params[1], 'sync_info');
        },
      },
    ],
    async () => {
      await emitSyncEvent('connector-signal', 'sync_info', { mailbox: 'INBOX' });
    },
  );

  const signal = await waitForSyncEventSignal('user-signal', 10, 5_000);
  assert.deepEqual(signal, { userId: 'user-signal', eventId: 42 });
  env.push.enabled = originalPushEnabled;
});

await test('waitForSyncEventSignal resolves null after timeout when no newer signals arrive', async () => {
  const started = Date.now();
  const signal = await waitForSyncEventSignal('user-timeout-path', 9999, 250);
  const elapsed = Date.now() - started;
  assert.equal(signal, null);
  assert.ok(elapsed >= 200, `expected timeout path to wait, elapsed=${elapsed}`);
});

await test('emitSyncEvent tolerates subscriber notification failures and missing user metadata', async () => {
  const originalPushEnabled = env.push.enabled;
  env.push.enabled = true;

  await withMockedQueries(
    [
      {
        rows: [{ id: '51', user_id: 'user-notify' }],
      },
      {
        error: new Error('push subscription query failed'),
      },
      {
        rows: [{ id: '52', user_id: null }],
      },
    ],
    async () => {
      await emitSyncEvent('connector-notify', 'sync_info', { mailbox: 'INBOX' });
      await emitSyncEvent('connector-notify', 'sync_info', { mailbox: 'INBOX' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  );

  env.push.enabled = originalPushEnabled;
});

await test('waitForSyncEventSignal ignores malformed notifications until a valid signal arrives', async () => {
  await withMockedConnect(
    async () => new FakeListenerClient(),
    async (createdClients) => {
      const waitPromise = waitForSyncEventSignal('user-invalid-notify', 0, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const client = createdClients[0];
      assert.ok(client);
      client.emit('notification', { channel: 'some_other_channel', payload: '{"userId":"user-invalid-notify","eventId":10}' });
      client.emit('notification', { channel: 'simplemail_sync_events' });
      client.emit('notification', { channel: 'simplemail_sync_events', payload: 'not-json' });
      client.emit('notification', { channel: 'simplemail_sync_events', payload: JSON.stringify({ userId: '', eventId: 10 }) });
      client.emit('notification', { channel: 'simplemail_sync_events', payload: JSON.stringify({ userId: 'user-invalid-notify', eventId: 0 }) });
      client.emit('notification', { channel: 'simplemail_sync_events', payload: JSON.stringify({ userId: 'user-invalid-notify', eventId: 11 }) });

      const signal = await waitPromise;
      assert.deepEqual(signal, { userId: 'user-invalid-notify', eventId: 11 });
    },
  );
});

await test('waitForSyncEventSignal shares listener bootstrap and resolves multiple waiters from one signal', async () => {
  let connectCalls = 0;
  const listener = new FakeListenerClient();

  await withMockedConnect(
    async () => {
      connectCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return listener;
    },
    async () => {
      const waiterA = waitForSyncEventSignal('user-multi-waiter', 0, 5_000);
      const waiterB = waitForSyncEventSignal('user-multi-waiter', 0, 5_000);

      await new Promise((resolve) => setTimeout(resolve, 40));
      listener.emit('notification', {
        channel: 'simplemail_sync_events',
        payload: JSON.stringify({ userId: 'user-multi-waiter', eventId: 21 }),
      } satisfies FakeNotification);

      const [signalA, signalB] = await Promise.all([waiterA, waiterB]);
      assert.deepEqual(signalA, { userId: 'user-multi-waiter', eventId: 21 });
      assert.deepEqual(signalB, { userId: 'user-multi-waiter', eventId: 21 });
      assert.equal(connectCalls, 1);
    },
  );
});

await test('waitForSyncEventSignal ignores stale event ids and resolves when a newer id arrives', async () => {
  await withMockedConnect(
    async () => new FakeListenerClient(),
    async (createdClients) => {
      const waitPromise = waitForSyncEventSignal('user-since-check', 50, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const client = createdClients[0];
      assert.ok(client);
      client.emit('notification', {
        channel: 'simplemail_sync_events',
        payload: JSON.stringify({ userId: 'user-since-check', eventId: 50 }),
      } satisfies FakeNotification);
      client.emit('notification', {
        channel: 'simplemail_sync_events',
        payload: JSON.stringify({ userId: 'user-since-check', eventId: 51 }),
      } satisfies FakeNotification);

      const signal = await waitPromise;
      assert.deepEqual(signal, { userId: 'user-since-check', eventId: 51 });
    },
  );
});

await test('waitForSyncEventSignal handles signal-after-subscribe race safely', async () => {
  const listener = new FakeListenerClient();
  await withMockedConnect(
    async () => listener,
    async () => {
      const originalSetAdd = Set.prototype.add;
      (Set.prototype as any).add = function patchedAdd(value: unknown) {
        const result = originalSetAdd.call(this, value);
        listener.emit('notification', {
          channel: 'simplemail_sync_events',
          payload: JSON.stringify({ userId: 'user-after-subscribe', eventId: 77 }),
        } satisfies FakeNotification);
        return result;
      };

      try {
        const signal = await waitForSyncEventSignal('user-after-subscribe', 0, 5_000);
        assert.deepEqual(signal, { userId: 'user-after-subscribe', eventId: 77 });
      } finally {
        (Set.prototype as any).add = originalSetAdd;
      }
    },
  );
});

await test('waitForSyncEventSignal recovers by reconnecting listener after client drop', async () => {
  const firstClient = new FakeListenerClient();
  const secondClient = new FakeListenerClient();
  let connectCount = 0;

  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 1_000) {
      handler(...args);
      return 1 as any;
    }
    return originalSetTimeout(handler, delay as any, ...args);
  };

  try {
    await withMockedConnect(
      async () => {
        connectCount += 1;
        return connectCount === 1 ? firstClient : secondClient;
      },
      async () => {
        const waitPromise = waitForSyncEventSignal('user-reconnect', 0, 5_000);
        await new Promise((resolve) => setTimeout(resolve, 10));

        firstClient.emit('error', new Error('listener dropped'));
        await new Promise((resolve) => setTimeout(resolve, 10));
        secondClient.emit('notification', {
          channel: 'simplemail_sync_events',
          payload: JSON.stringify({ userId: 'user-reconnect', eventId: 31 }),
        } satisfies FakeNotification);

        const signal = await waitPromise;
        assert.deepEqual(signal, { userId: 'user-reconnect', eventId: 31 });
        assert.equal(firstClient.released, true);
        assert.equal(connectCount >= 2, true);
      },
    );
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
  }
});

await test('waitForSyncEventSignal handles LISTEN setup failures by releasing the client and returning null', async () => {
  const failingClient = new FakeListenerClient();
  failingClient.query = async (text: string) => {
    failingClient.listenQueries.push(String(text));
    throw new Error('LISTEN failed');
  };

  await withMockedConnect(
    async () => failingClient,
    async () => {
      const signal = await waitForSyncEventSignal('user-listen-failure', 0, 250);
      assert.equal(signal, null);
      assert.equal(failingClient.released, true);
      assert.equal(failingClient.listenQueries.length, 1);
      assert.match(failingClient.listenQueries[0], /LISTEN simplemail_sync_events/);
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
