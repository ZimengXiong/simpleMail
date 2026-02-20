import assert from 'node:assert/strict';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

(globalThis as any).window = {
  location: { href: '', origin: 'http://localhost:5173' },
  setTimeout,
  open: () => null,
};

let fetchCalls: FetchCall[] = [];

const setFetchResponse = (resolver: (call: FetchCall) => Promise<Response> | Response) => {
  fetchCalls = [];
  (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { input, init };
    fetchCalls.push(call);
    return resolver(call);
  };
};

const jsonResponse = (payload: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
  });

const getCallHeaders = (call: FetchCall) => new Headers(call.init?.headers);

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

const { api, getAuthToken } = await import('../../client/src/services/api.ts');

await test('auth.login stores runtime token and marks session authenticated', () => {
  api.auth.clear();
  (globalThis as any).window.location.href = '';

  api.auth.login('token-1');

  assert.equal(getAuthToken(), 'token-1');
  assert.equal(api.auth.isAuthenticated(), true);
});

await test('auth.logout clears runtime token and redirects to login', () => {
  api.auth.login('token-2');
  (globalThis as any).window.location.href = '';

  api.auth.logout();

  assert.equal(getAuthToken(), null);
  assert.equal((globalThis as any).window.location.href, '/login');
  assert.equal(api.auth.isAuthenticated(), false);
});

await test('uses bearer token and JSON body headers for send requests with idempotency key', async () => {
  api.auth.login('bearer-abc');
  setFetchResponse(() => jsonResponse({ status: 'ok', sendId: 'send-1' }));

  await api.messages.send({ to: 'a@example.com', subject: 'Hello' }, 'idem-1');

  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), '/api/messages/send');
  assert.equal(fetchCalls[0].init?.method, 'POST');

  const headers = getCallHeaders(fetchCalls[0]);
  assert.equal(headers.get('Authorization'), 'Bearer bearer-abc');
  assert.equal(headers.get('Idempotency-Key'), 'idem-1');
  assert.equal(headers.get('Content-Type'), 'application/json');
});

await test('builds message listing query params correctly', async () => {
  setFetchResponse(() => jsonResponse({ messages: [], totalCount: 0 }));

  await api.messages.list({
    folder: 'INBOX',
    connectorId: 'conn-1',
    limit: 25,
    offset: 5,
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(
    String(fetchCalls[0].input),
    '/api/messages?folder=INBOX&connectorId=conn-1&limit=25&offset=5',
  );
});

await test('clears auth and redirects on unauthorized API responses', async () => {
  api.auth.login('token-401');
  (globalThis as any).window.location.href = '';
  setFetchResponse(() => jsonResponse({ error: 'Unauthorized' }, 401));

  await assert.rejects(() => api.connectors.listIncoming(), /Unauthorized/);

  assert.equal(getAuthToken(), null);
  assert.equal((globalThis as any).window.location.href, '/login');
  assert.equal(api.auth.isAuthenticated(), false);
});

await test('fetches attachment preview blob with bearer auth header', async () => {
  api.auth.login('blob-token-1');
  setFetchResponse(() => new Response('blob-body', {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
    },
  }));

  const blob = await api.attachments.getPreviewBlob('att-blob');

  assert.equal(blob instanceof Blob, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), '/api/attachments/att-blob/view');
  const headers = getCallHeaders(fetchCalls[0]);
  assert.equal(headers.get('Authorization'), 'Bearer blob-token-1');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
