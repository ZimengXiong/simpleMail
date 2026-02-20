import assert from 'node:assert/strict';
import { gmailApiRequest, listAllGmailPages } from '../gmailApi.js';

type FetchResponseFactory = () => Promise<Response> | Response;

const withFetchSequence = async (
  responses: FetchResponseFactory[],
  fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void> | void,
) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  let index = 0;

  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[index];
    if (!next) {
      throw new Error(`Unexpected fetch #${index + 1}: ${url}`);
    }
    index += 1;
    return next();
  };

  try {
    await fn(calls);
    assert.equal(index, responses.length, `Expected ${responses.length} fetch calls, got ${index}`);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
};

const withImmediateTimers = async (fn: () => Promise<void> | void) => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (handler: (...args: any[]) => void, _ms?: number) => {
    handler();
    return 0;
  };
  try {
    await fn();
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
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

await test('sends auth + JSON headers and parses successful payload', async () => {
  const connector = { id: 'conn-1', auth_config: { authType: 'password', accessToken: 'token-1' } };

  await withFetchSequence(
    [
      () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ],
    async (calls) => {
      const payload = await gmailApiRequest('incoming', connector, '/messages/123', {
        method: 'POST',
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.deepEqual(payload, { ok: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/123');
      const headers = calls[0]?.init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer token-1');
      assert.equal(headers.Accept, 'application/json');
      assert.equal(headers['Content-Type'], 'application/json');
    },
  );
});

await test('returns undefined for 204 response payload', async () => {
  const connector = { id: 'conn-1', auth_config: { authType: 'password', accessToken: 'token-1' } };

  await withFetchSequence(
    [
      () => new Response(null, { status: 204 }),
    ],
    async () => {
      const payload = await gmailApiRequest('incoming', connector, '/messages/123');
      assert.equal(payload, undefined);
    },
  );
});

await test('retries token-invalid responses and recoverable network errors', async () => {
  const connector = { id: 'conn-2', auth_config: { authType: 'password', accessToken: 'token-2' } };

  await withImmediateTimers(async () => {
    await withFetchSequence(
      [
        () => new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ],
      async () => {
        const payload = await gmailApiRequest('incoming', connector, '/labels');
        assert.deepEqual(payload, { ok: true });
      },
    );
  });

  await withImmediateTimers(async () => {
    await withFetchSequence(
      [
        () => {
          throw Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' });
        },
        () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ],
      async () => {
        const payload = await gmailApiRequest('incoming', connector, '/threads');
        assert.deepEqual(payload, { ok: true });
      },
    );
  });
});

await test('throws non-retryable API errors with context', async () => {
  const connector = { id: 'conn-3', auth_config: { authType: 'password', accessToken: 'token-3' } };

  await withFetchSequence(
    [
      () => new Response('bad request', { status: 400, statusText: 'Bad Request' }),
    ],
    async () => {
      await assert.rejects(
        gmailApiRequest('incoming', connector, '/messages'),
        /Gmail API 400 Bad Request: bad request/,
      );
    },
  );
});

await test('listAllGmailPages aggregates results across page tokens', async () => {
  const connector = { id: 'conn-4', auth_config: { authType: 'password', accessToken: 'token-4' } };
  const seenPaths: string[] = [];

  await withFetchSequence(
    [
      () => new Response(JSON.stringify({ items: ['a'], nextPageToken: 'tok-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      () => new Response(JSON.stringify({ items: ['b', 'c'] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ],
    async () => {
      const items = await listAllGmailPages(
        'incoming',
        connector,
        (token) => {
          const path = token ? `/messages?pageToken=${token}` : '/messages';
          seenPaths.push(path);
          return path;
        },
        (payload) => payload.items ?? [],
      );
      assert.deepEqual(items, ['a', 'b', 'c']);
      assert.deepEqual(seenPaths, ['/messages', '/messages?pageToken=tok-1']);
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
