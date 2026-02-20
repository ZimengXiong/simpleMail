import assert from 'node:assert/strict';
import { OAuth2Client } from 'google-auth-library';
import { pool } from '../../db/pool.js';
import {
  consumeOAuthState,
  createOAuthState,
  ensureValidGoogleAccessToken,
  exchangeCodeForTokens,
  getGoogleAuthorizeUrl,
  isGoogleTokenExpiringSoon,
} from '../googleOAuth.js';

type QueryCall = {
  text: string;
  params: any[];
};

type QueryStep = {
  rows?: any[];
  error?: Error;
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

const withMockedOAuth2Client = async (
  overrides: Partial<{
    generateAuthUrl: (opts: any) => string;
    getToken: (code: string) => Promise<{ tokens: Record<string, any> }>;
    refreshAccessToken: () => Promise<{ credentials: Record<string, any> }>;
    setCredentials: (creds: Record<string, any>) => void;
  }>,
  fn: () => Promise<void> | void,
) => {
  const originalGenerateAuthUrl = OAuth2Client.prototype.generateAuthUrl;
  const originalGetToken = OAuth2Client.prototype.getToken;
  const originalRefreshAccessToken = OAuth2Client.prototype.refreshAccessToken;
  const originalSetCredentials = OAuth2Client.prototype.setCredentials;

  if (overrides.generateAuthUrl) {
    (OAuth2Client.prototype as any).generateAuthUrl = function mockGenerateAuthUrl(opts: any) {
      return overrides.generateAuthUrl!(opts);
    };
  }
  if (overrides.getToken) {
    (OAuth2Client.prototype as any).getToken = function mockGetToken(code: string) {
      return overrides.getToken!(code);
    };
  }
  if (overrides.refreshAccessToken) {
    (OAuth2Client.prototype as any).refreshAccessToken = function mockRefreshAccessToken() {
      return overrides.refreshAccessToken!();
    };
  }
  if (overrides.setCredentials) {
    (OAuth2Client.prototype as any).setCredentials = function mockSetCredentials(creds: Record<string, any>) {
      return overrides.setCredentials!(creds);
    };
  }

  try {
    await fn();
  } finally {
    OAuth2Client.prototype.generateAuthUrl = originalGenerateAuthUrl;
    OAuth2Client.prototype.getToken = originalGetToken;
    OAuth2Client.prototype.refreshAccessToken = originalRefreshAccessToken;
    OAuth2Client.prototype.setCredentials = originalSetCredentials;
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

await test('createOAuthState persists state token with connector metadata', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.match(call.text, /INSERT INTO oauth_states/);
          assert.equal(call.params[1], 'connector-1');
          assert.equal(call.params[2], 'incoming');
          assert.equal(call.params[3], 'user-1');
          assert.ok(typeof call.params[4] === 'number');
        },
      },
    ],
    async () => {
      const state = await createOAuthState('incoming', 'connector-1', 'user-1');
      assert.match(state, /^[0-9a-f-]{36}$/i);
    },
  );
});

await test('consumeOAuthState returns mapped state payload when token is valid', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ connector_id: 'connector-2', connector_type: 'outgoing', user_id: 'user-2' }],
        check: (call) => {
          assert.match(call.text, /DELETE FROM oauth_states/);
          assert.deepEqual(call.params, ['oauth-state-1']);
        },
      },
    ],
    async () => {
      const consumed = await consumeOAuthState('oauth-state-1');
      assert.deepEqual(consumed, {
        type: 'outgoing',
        connectorId: 'connector-2',
        userId: 'user-2',
      });
    },
  );
});

await test('consumeOAuthState fails closed and returns null on storage errors', async () => {
  await withMockedQueries(
    [
      {
        error: new Error('db unavailable'),
      },
    ],
    async () => {
      const consumed = await consumeOAuthState('oauth-state-2');
      assert.equal(consumed, null);
    },
  );
});

await test('consumeOAuthState rejects overly long state values before querying storage', async () => {
  await withMockedQueries([], async () => {
    const consumed = await consumeOAuthState('x'.repeat(201));
    assert.equal(consumed, null);
  });
});

await test('getGoogleAuthorizeUrl creates state and forwards scope/prompt options', async () => {
  let insertedState = '';
  let authOptions: any = null;

  await withMockedQueries(
    [
      {
        check: (call) => {
          insertedState = String(call.params[0] ?? '');
          assert.match(insertedState, /^[0-9a-f-]{36}$/i);
          assert.equal(call.params[1], 'connector-3');
          assert.equal(call.params[2], 'incoming');
          assert.equal(call.params[3], 'user-3');
        },
      },
    ],
    async () => {
      await withMockedOAuth2Client(
        {
          generateAuthUrl: (opts) => {
            authOptions = opts;
            return 'https://accounts.google.test/oauth/authorize';
          },
        },
        async () => {
          const url = await getGoogleAuthorizeUrl('incoming', 'connector-3', 'cid', 'secret', 'user-3');
          assert.equal(url, 'https://accounts.google.test/oauth/authorize');
          assert.equal(authOptions?.state, insertedState);
          assert.equal(authOptions?.access_type, 'offline');
          assert.equal(authOptions?.prompt, 'consent');
          assert.ok(Array.isArray(authOptions?.scope));
          assert.ok(authOptions.scope.includes('https://www.googleapis.com/auth/gmail.readonly'));
          assert.ok(authOptions.scope.includes('https://mail.google.com/'));
        },
      );
    },
  );
});

await test('exchangeCodeForTokens returns token payload and rejects missing access token', async () => {
  await withMockedOAuth2Client(
    {
      getToken: async (code) => {
        assert.equal(code, 'code-1');
        return { tokens: { access_token: 'access-1', refresh_token: 'refresh-1' } };
      },
    },
    async () => {
      const tokens = await exchangeCodeForTokens('code-1', 'cid', 'secret');
      assert.equal(tokens.access_token, 'access-1');
      assert.equal(tokens.refresh_token, 'refresh-1');
    },
  );

  await withMockedOAuth2Client(
    {
      getToken: async () => ({ tokens: { refresh_token: 'refresh-only' } }),
    },
    async () => {
      await assert.rejects(
        exchangeCodeForTokens('code-2', 'cid', 'secret'),
        /no access token/i,
      );
    },
  );
});

await test('ensureValidGoogleAccessToken refreshes expired token and persists updates', async () => {
  const setCredentialCalls: Record<string, any>[] = [];
  const expiryDate = Date.now() + 60 * 60 * 1000;

  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.match(call.text, /UPDATE incoming_connectors SET auth_config/);
          assert.equal(call.params[0], 'connector-4');
          const persisted = JSON.parse(String(call.params[1]));
          assert.equal(persisted.accessToken, 'new-access-token');
          assert.equal(persisted.refreshToken, 'refresh-4');
          assert.ok(typeof persisted.tokenExpiresAt === 'string');
        },
      },
    ],
    async () => {
      await withMockedOAuth2Client(
        {
          setCredentials: (creds) => {
            setCredentialCalls.push(creds);
          },
          refreshAccessToken: async () => ({
            credentials: {
              access_token: 'new-access-token',
              refresh_token: 'refresh-4',
              expiry_date: expiryDate,
            },
          }),
        },
        async () => {
          const result = await ensureValidGoogleAccessToken(
            'incoming',
            'connector-4',
            {
              authType: 'oauth2',
              accessToken: 'old-access-token',
              refreshToken: 'refresh-4',
              tokenExpiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
              oauthClientId: 'cid',
              oauthClientSecret: 'secret',
            },
          );

          assert.equal(setCredentialCalls.length, 1);
          assert.equal(setCredentialCalls[0]?.refresh_token, 'refresh-4');
          assert.equal(result.accessToken, 'new-access-token');
          assert.equal(result.refreshToken, 'refresh-4');
          assert.equal(isGoogleTokenExpiringSoon(result, 10_000), false);
        },
      );
    },
  );
});

await test('ensureValidGoogleAccessToken revokes access on invalid grant errors', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.match(call.text, /UPDATE outgoing_connectors SET auth_config/);
          const persisted = JSON.parse(String(call.params[1]));
          assert.equal(persisted.accessToken, null);
          assert.equal(persisted.tokenExpiresAt, null);
          assert.equal(call.params[0], 'connector-5');
        },
      },
    ],
    async () => {
      await withMockedOAuth2Client(
        {
          refreshAccessToken: async () => {
            throw new Error('invalid_grant');
          },
        },
        async () => {
          await assert.rejects(
            ensureValidGoogleAccessToken(
              'outgoing',
              'connector-5',
              {
                authType: 'oauth2',
                accessToken: 'expired',
                refreshToken: 'refresh-5',
                tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
                oauthClientId: 'cid',
                oauthClientSecret: 'secret',
              },
            ),
            /must reconnect account/i,
          );
        },
      );
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
