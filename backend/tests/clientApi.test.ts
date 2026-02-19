import assert from 'node:assert/strict';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }

  removeItem(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

const TOKEN_KEY = 'BETTERMAIL_USER_TOKEN';

const sessionStorageMock = new MemoryStorage();
const localStorageMock = new MemoryStorage();

(globalThis as any).sessionStorage = sessionStorageMock;
(globalThis as any).localStorage = localStorageMock;
(globalThis as any).window = {
  location: { href: '' },
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

const { api } = await import('../../client/src/services/api.ts');

await test('auth.login persists token in session storage and marks session authenticated', () => {
  sessionStorageMock.clear();
  localStorageMock.clear();
  (globalThis as any).window.location.href = '';

  api.auth.login('token-1');

  assert.equal(sessionStorageMock.getItem(TOKEN_KEY), 'token-1');
  assert.equal(localStorageMock.getItem(TOKEN_KEY), null);
  assert.equal(api.auth.isAuthenticated(), true);
});

await test('auth.logout clears stored tokens and redirects to login', () => {
  sessionStorageMock.setItem(TOKEN_KEY, 'token-2');
  localStorageMock.setItem(TOKEN_KEY, 'legacy-token');
  (globalThis as any).window.location.href = '';

  api.auth.logout();

  assert.equal(sessionStorageMock.getItem(TOKEN_KEY), null);
  assert.equal(localStorageMock.getItem(TOKEN_KEY), null);
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

  assert.equal(sessionStorageMock.getItem(TOKEN_KEY), null);
  assert.equal(localStorageMock.getItem(TOKEN_KEY), null);
  assert.equal((globalThis as any).window.location.href, '/login');
  assert.equal(api.auth.isAuthenticated(), false);
});

await test('migrates legacy localStorage auth token into sessionStorage on first auth check', () => {
  sessionStorageMock.clear();
  localStorageMock.clear();

  localStorageMock.setItem(TOKEN_KEY, 'legacy-token');

  assert.equal(api.auth.isAuthenticated(), true);
  assert.equal(sessionStorageMock.getItem(TOKEN_KEY), 'legacy-token');
  assert.equal(localStorageMock.getItem(TOKEN_KEY), null);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
