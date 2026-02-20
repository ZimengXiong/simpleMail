import assert from 'node:assert/strict';
import webPush from 'web-push';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import {
  configurePush,
  createPushSubscription,
  notifySubscribers,
  removePushSubscription,
} from '../push.js';

type QueryStep = {
  rows?: any[];
  check?: (text: string, params: any[]) => void;
};

const withMockedQueries = async (steps: QueryStep[], fn: () => Promise<void> | void) => {
  const originalQuery = pool.query.bind(pool);
  let index = 0;

  (pool as any).query = async (text: string, params: any[] = []) => {
    const step = steps[index];
    if (!step) {
      throw new Error(`Unexpected query #${index + 1}: ${text}`);
    }
    index += 1;
    step.check?.(String(text), Array.isArray(params) ? params : []);
    return { rows: step.rows ?? [] };
  };

  try {
    await fn();
    assert.equal(index, steps.length, `Expected ${steps.length} queries, got ${index}`);
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

await test('configurePush applies vapid details only when push is enabled', async () => {
  const originalEnabled = env.push.enabled;
  const originalSetVapidDetails = webPush.setVapidDetails;
  const vapidCalls: Array<{ email: string; publicKey: string; privateKey: string }> = [];

  (webPush as any).setVapidDetails = (email: string, publicKey: string, privateKey: string) => {
    vapidCalls.push({ email, publicKey, privateKey });
  };

  try {
    env.push.enabled = false;
    configurePush();
    assert.equal(vapidCalls.length, 0);

    env.push.enabled = true;
    configurePush();
    assert.equal(vapidCalls.length, 1);
    assert.equal(vapidCalls[0]?.email, env.push.email);
    assert.equal(vapidCalls[0]?.publicKey, env.push.publicKey);
    assert.equal(vapidCalls[0]?.privateKey, env.push.privateKey);
  } finally {
    env.push.enabled = originalEnabled;
    (webPush as any).setVapidDetails = originalSetVapidDetails;
  }
});

await test('createPushSubscription handles insert success and conflict paths', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'sub-1' }],
        check: (text, params) => {
          assert.match(text, /INSERT INTO push_subscriptions/);
          assert.deepEqual(params, ['user-1', 'https://example/push', 'p256dh', 'auth', 'ua']);
        },
      },
    ],
    async () => {
      const created = await createPushSubscription({
        userId: 'user-1',
        endpoint: 'https://example/push',
        p256dh: 'p256dh',
        auth: 'auth',
        userAgent: 'ua',
      });
      assert.deepEqual(created, { id: 'sub-1' });
    },
  );

  await withMockedQueries(
    [
      { rows: [] },
      {
        rows: [{ user_id: 'other-user' }],
      },
    ],
    async () => {
      await assert.rejects(
        createPushSubscription({
          userId: 'user-1',
          endpoint: 'https://example/push',
          p256dh: 'p256dh',
          auth: 'auth',
        }),
        (error: any) => {
          assert.equal(error?.statusCode, 409);
          assert.match(String(error?.message), /already registered/i);
          return true;
        },
      );
    },
  );

  await withMockedQueries(
    [
      { rows: [] },
      { rows: [] },
    ],
    async () => {
      await assert.rejects(
        createPushSubscription({
          userId: 'user-1',
          endpoint: 'https://example/push',
          p256dh: 'p256dh',
          auth: 'auth',
        }),
        /failed to create push subscription/,
      );
    },
  );
});

await test('removes push subscriptions by user + endpoint', async () => {
  await withMockedQueries(
    [
      {
        check: (text, params) => {
          assert.equal(text, 'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2');
          assert.deepEqual(params, ['user-1', 'https://example/push']);
        },
      },
    ],
    async () => {
      await removePushSubscription('user-1', 'https://example/push');
    },
  );
});

await test('notifySubscribers no-ops when push is disabled and sends best-effort when enabled', async () => {
  const originalEnabled = env.push.enabled;
  const originalSendNotification = webPush.sendNotification;
  const sendCalls: Array<{ endpoint: string; payload: string }> = [];

  (webPush as any).sendNotification = async (subscription: any, payload: string) => {
    sendCalls.push({ endpoint: subscription.endpoint, payload });
    if (subscription.endpoint.includes('fail')) {
      throw new Error('delivery failed');
    }
  };

  try {
    env.push.enabled = false;
    await withMockedQueries([], async () => {
      await notifySubscribers('user-1', { event: 'noop' });
    });
    assert.equal(sendCalls.length, 0);

    env.push.enabled = true;
    await withMockedQueries(
      [
        {
          rows: [
            { endpoint: 'https://ok.example/push', p256dh: 'p1', auth: 'a1' },
            { endpoint: 'https://fail.example/push', p256dh: 'p2', auth: 'a2' },
          ],
          check: (text, params) => {
            assert.equal(text, 'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1');
            assert.deepEqual(params, ['user-1']);
          },
        },
      ],
      async () => {
        await notifySubscribers('user-1', { event: 'sync_complete', mailbox: 'INBOX' });
      },
    );
    assert.equal(sendCalls.length, 2);
    assert.equal(sendCalls[0]?.endpoint, 'https://ok.example/push');
    assert.equal(sendCalls[1]?.endpoint, 'https://fail.example/push');
    assert.deepEqual(JSON.parse(sendCalls[0]?.payload ?? '{}'), { event: 'sync_complete', mailbox: 'INBOX' });
  } finally {
    env.push.enabled = originalEnabled;
    (webPush as any).sendNotification = originalSendNotification;
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
