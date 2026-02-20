import assert from 'node:assert/strict';

type MutableLocation = {
  href?: string;
  origin?: string;
  pathname?: string;
  search?: string;
  hash?: string;
  assign?: (value: string) => void;
};

const setWindowLocation = (location: MutableLocation) => {
  (globalThis as { window?: unknown }).window = { location };
};

setWindowLocation({
  href: 'http://localhost:5173/',
  origin: 'http://localhost:5173',
  pathname: '/',
  search: '',
  hash: '',
});

const {
  buildLoginPath,
  redirectToLogin,
  resolveSafeNextPath,
  toAbsoluteAppUrl,
} = await import('../../client/src/services/authRedirect.ts');

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

await test('resolveSafeNextPath keeps valid app-relative paths', () => {
  assert.equal(resolveSafeNextPath('/inbox?folder=INBOX#top'), '/inbox?folder=INBOX#top');
});

await test('resolveSafeNextPath rejects external URLs', () => {
  assert.equal(resolveSafeNextPath('https://example.com/steal'), '/inbox');
});

await test('resolveSafeNextPath avoids login-loop paths', () => {
  assert.equal(resolveSafeNextPath('/login?next=%2Finbox'), '/inbox');
});

await test('buildLoginPath captures current path when available', () => {
  setWindowLocation({
    href: 'http://localhost:5173/thread/abc?connectorId=c1',
    origin: 'http://localhost:5173',
    pathname: '/thread/abc',
    search: '?connectorId=c1',
    hash: '',
  });
  assert.equal(
    buildLoginPath(),
    '/login?next=%2Fthread%2Fabc%3FconnectorId%3Dc1',
  );
});

await test('buildLoginPath falls back to bare login path when no context exists', () => {
  setWindowLocation({
    href: '',
    origin: 'http://localhost:5173',
  });
  assert.equal(buildLoginPath(), '/login');
});

await test('redirectToLogin uses location.assign when available', () => {
  let assigned = '';
  setWindowLocation({
    href: 'http://localhost:5173/inbox',
    origin: 'http://localhost:5173',
    pathname: '/inbox',
    search: '',
    hash: '',
    assign: (value: string) => {
      assigned = value;
    },
  });
  redirectToLogin('/inbox?page=2');
  assert.equal(assigned, '/login?next=%2Finbox%3Fpage%3D2');
});

await test('toAbsoluteAppUrl returns same-origin absolute URL', () => {
  setWindowLocation({
    href: 'http://localhost:5173/',
    origin: 'http://localhost:5173',
    pathname: '/',
    search: '',
    hash: '',
  });
  assert.equal(
    toAbsoluteAppUrl('/inbox?folder=INBOX'),
    'http://localhost:5173/inbox?folder=INBOX',
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
