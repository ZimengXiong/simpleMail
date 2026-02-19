import assert from 'node:assert/strict';
import { ensureValidGoogleAccessToken } from '../googleOAuth.js';

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

const minutesFromNowIso = (minutes: number) =>
  new Date(Date.now() + (minutes * 60 * 1000)).toISOString();

const minutesAgoIso = (minutes: number) =>
  new Date(Date.now() - (minutes * 60 * 1000)).toISOString();

await test('returns auth config unchanged for non-oauth credentials', async () => {
  const auth = { authType: 'password', username: 'user', password: 'secret' };
  const result = await ensureValidGoogleAccessToken('incoming', 'connector-1', auth);
  assert.equal(result, auth);
});

await test('allows valid access token without refresh token when not expiring', async () => {
  const auth = {
    authType: 'oauth2',
    accessToken: 'token-1',
    tokenExpiresAt: minutesFromNowIso(30),
    refreshToken: null,
  };
  const result = await ensureValidGoogleAccessToken('outgoing', 'connector-2', auth as Record<string, any>);
  assert.equal(result, auth);
});

await test('rejects missing refresh token when access token is expired', async () => {
  const auth = {
    authType: 'oauth2',
    accessToken: 'expired-token',
    tokenExpiresAt: minutesAgoIso(30),
    refreshToken: null,
  };
  await assert.rejects(
    ensureValidGoogleAccessToken('incoming', 'connector-3', auth as Record<string, any>),
    /refresh token is missing/i,
  );
});

await test('rejects missing refresh token when force refresh is requested', async () => {
  const auth = {
    authType: 'oauth2',
    accessToken: 'token-2',
    tokenExpiresAt: minutesFromNowIso(30),
    refreshToken: null,
  };
  await assert.rejects(
    ensureValidGoogleAccessToken('incoming', 'connector-4', auth as Record<string, any>, { forceRefresh: true }),
    /refresh token is missing/i,
  );
});

await test('treats invalid token expiry as expired when refresh token is missing', async () => {
  const auth = {
    authType: 'oauth2',
    accessToken: 'token-3',
    tokenExpiresAt: 'not-a-date',
    refreshToken: null,
  };
  await assert.rejects(
    ensureValidGoogleAccessToken('incoming', 'connector-5', auth as Record<string, any>),
    /refresh token is missing/i,
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
