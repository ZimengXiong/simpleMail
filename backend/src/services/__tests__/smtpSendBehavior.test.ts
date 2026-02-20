import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OAuth2Client } from 'google-auth-library';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import {
  sendThroughConnector,
  verifyOutgoingConnectorCredentials,
} from '../smtp.js';
import { createQueue } from '../queue.js';

const require = createRequire(import.meta.url);
const MailComposer = require('nodemailer/lib/mail-composer/index.js');

type QueryCall = {
  text: string;
  params: any[];
};

type QueryStep = {
  rows?: any[];
  error?: Error;
  check?: (call: QueryCall) => void;
};

type MailCall = {
  envelope: {
    from: string;
    to: string[];
  };
  raw: Buffer;
};

type TransportStub = {
  verifyCalls: number;
  closeCalls: number;
  sendCalls: MailCall[];
  options: Record<string, any>;
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

const withMockedTransportFactory = async (
  behaviors: Array<{
    verifyError?: Error;
    sendError?: Error;
  }>,
  fn: (stubs: TransportStub[]) => Promise<void> | void,
) => {
  const originalCreateTransport = (nodemailer as any).createTransport;
  const stubs: TransportStub[] = [];
  let behaviorIndex = 0;

  (nodemailer as any).createTransport = (options: Record<string, any>) => {
    const behavior = behaviors[Math.min(behaviorIndex, behaviors.length - 1)] ?? {};
    behaviorIndex += 1;

    const stub: TransportStub = {
      verifyCalls: 0,
      closeCalls: 0,
      sendCalls: [],
      options,
    };
    stubs.push(stub);

    return {
      verify: async () => {
        stub.verifyCalls += 1;
        if (behavior.verifyError) {
          throw behavior.verifyError;
        }
      },
      sendMail: async (payload: MailCall) => {
        stub.sendCalls.push(payload);
        if (behavior.sendError) {
          throw behavior.sendError;
        }
      },
      close: () => {
        stub.closeCalls += 1;
      },
    };
  };

  try {
    await fn(stubs);
  } finally {
    (nodemailer as any).createTransport = originalCreateTransport;
  }
};

const withMockedFetch = async (
  responder: (url: string, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<void> | void,
) => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = (url: string, init?: RequestInit) => Promise.resolve(responder(url, init));
  try {
    await fn();
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
};

const withInstantTimers = async (fn: () => Promise<void> | void) => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (handler: (...args: any[]) => void, _delay?: number) => {
    handler();
    return 1 as any;
  };

  try {
    await fn();
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
  }
};

const withMockedOAuthRefresh = async (
  refreshImpl: () => Promise<{ credentials: Record<string, any> }>,
  fn: () => Promise<void> | void,
) => {
  const originalRefreshAccessToken = OAuth2Client.prototype.refreshAccessToken;
  (OAuth2Client.prototype as any).refreshAccessToken = function refreshAccessToken() {
    return refreshImpl();
  };
  try {
    await fn();
  } finally {
    OAuth2Client.prototype.refreshAccessToken = originalRefreshAccessToken;
  }
};

const withMockedImapFlowMethods = async (
  overrides: Record<string, any>,
  fn: () => Promise<void> | void,
) => {
  const prototype = ImapFlow.prototype as any;
  const originals = new Map<string, any>();
  for (const [key, value] of Object.entries(overrides)) {
    originals.set(key, prototype[key]);
    prototype[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of originals.entries()) {
      prototype[key] = value;
    }
  }
};

const withMockedQueueAddJob = async (
  addJobImpl: (task: string, payload: Record<string, any>, options: Record<string, any>) => Promise<void> | void,
  fn: () => Promise<void> | void,
) => {
  const queue = await createQueue();
  const originalAddJob = (queue as any).addJob;
  (queue as any).addJob = async (task: string, payload: Record<string, any>, options: Record<string, any>) =>
    addJobImpl(task, payload, options);
  try {
    await fn();
  } finally {
    (queue as any).addJob = originalAddJob;
  }
};

const withMockedDateNow = async <T>(
  nowValue: number,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const originalDateNow = Date.now;
  Date.now = () => nowValue;
  try {
    return await fn();
  } finally {
    Date.now = originalDateNow;
  }
};

const withMockedMailComposerBuild = async (
  buildImpl: (cb: (err: unknown, msg: Buffer | string | null | Uint8Array) => void) => void,
  fn: () => Promise<void> | void,
) => {
  const originalCompile = MailComposer.prototype.compile;
  (MailComposer.prototype as any).compile = function compile() {
    return {
      build: (cb: (err: unknown, msg: Buffer | string | null | Uint8Array) => void) => buildImpl(cb),
    };
  };
  try {
    await fn();
  } finally {
    MailComposer.prototype.compile = originalCompile;
  }
};

let passed = 0;
let failed = 0;
const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
env.allowPrivateNetworkTargets = true;

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

await test('verifyOutgoingConnectorCredentials verifies transport and always closes it', async () => {
  await withMockedTransportFactory(
    [{}],
    async (stubs) => {
      await verifyOutgoingConnectorCredentials({
        provider: 'smtp',
        fromAddress: 'sender@example.com',
        host: 'smtp.example.com',
        port: 587,
        tlsMode: 'starttls',
        authType: 'password',
        authConfig: {
          username: 'sender@example.com',
          password: 'secret',
        },
      });

      assert.equal(stubs.length, 1);
      assert.equal(stubs[0].verifyCalls, 1);
      assert.equal(stubs[0].closeCalls, 1);
      assert.equal(stubs[0].options.host, 'smtp.example.com');
      assert.equal(stubs[0].options.requireTLS, true);
    },
  );
});

await test('verifyOutgoingConnectorCredentials rejects unsupported oauth2 provider and missing password auth fields', async () => {
  await assert.rejects(
    verifyOutgoingConnectorCredentials({
      provider: 'smtp',
      fromAddress: 'sender@example.com',
      host: 'smtp.example.com',
      port: 587,
      tlsMode: 'starttls',
      authType: 'oauth2',
      authConfig: {
        accessToken: 'token',
      },
    }),
    /only supported for provider=gmail/i,
  );

  await assert.rejects(
    verifyOutgoingConnectorCredentials({
      provider: 'smtp',
      fromAddress: 'sender@example.com',
      host: 'smtp.example.com',
      port: 587,
      tlsMode: 'starttls',
      authType: 'password',
      authConfig: {
        username: '',
        password: '',
      },
    }),
    /SMTP username and password are required/i,
  );
});

await test('verifyOutgoingConnectorCredentials validates host/port/tls-mode constraints', async () => {
  await assert.rejects(
    verifyOutgoingConnectorCredentials({
      provider: 'smtp',
      fromAddress: 'sender@example.com',
      host: 'smtp.example.com',
      port: 70000,
      tlsMode: 'starttls',
      authType: 'password',
      authConfig: { username: 'sender@example.com', password: 'secret' },
    }),
    /port must be an integer/i,
  );

  await assert.rejects(
    verifyOutgoingConnectorCredentials({
      provider: 'smtp',
      fromAddress: 'sender@example.com',
      host: '',
      port: 587,
      tlsMode: 'starttls',
      authType: 'password',
      authConfig: { username: 'sender@example.com', password: 'secret' },
    }),
    /host is required/i,
  );

  const originalAllowInsecure = env.allowInsecureMailTransport;
  const originalNodeEnv = env.nodeEnv;
  env.allowInsecureMailTransport = false;
  env.nodeEnv = 'production';
  try {
    await assert.rejects(
      verifyOutgoingConnectorCredentials({
        provider: 'smtp',
        fromAddress: 'sender@example.com',
        host: 'smtp.example.com',
        port: 25,
        tlsMode: 'none',
        authType: 'password',
        authConfig: { username: 'sender@example.com', password: 'secret' },
      }),
      /unencrypted SMTP transport is disabled/i,
    );
  } finally {
    env.allowInsecureMailTransport = originalAllowInsecure;
    env.nodeEnv = originalNodeEnv;
  }
});

await test('verifyOutgoingConnectorCredentials builds Gmail OAuth transport and enforces oauth requirements', async () => {
  await withMockedTransportFactory(
    [{}],
    async (stubs) => {
      await verifyOutgoingConnectorCredentials({
        provider: 'gmail',
        fromAddress: 'gmail.sender@example.com',
        host: null,
        port: null,
        tlsMode: 'ssl',
        authType: 'oauth2',
        authConfig: {
          authType: 'oauth2',
          oauthClientId: 'client-id',
          oauthClientSecret: 'client-secret',
          refreshToken: 'refresh-token',
        },
      });

      assert.equal(stubs.length, 1);
      assert.equal(stubs[0].options.host, 'smtp.gmail.com');
      assert.equal(stubs[0].options.secure, true);
      assert.equal(stubs[0].options.auth.type, 'OAuth2');
      assert.equal(stubs[0].options.auth.user, 'gmail.sender@example.com');
    },
  );

  await assert.rejects(
    verifyOutgoingConnectorCredentials({
      provider: 'gmail',
      fromAddress: '  ',
      host: null,
      port: null,
      tlsMode: 'starttls',
      authType: 'oauth2',
      authConfig: {
        authType: 'oauth2',
        refreshToken: 'refresh-token',
      },
    }),
    /requires a from address/i,
  );

  await assert.rejects(
    verifyOutgoingConnectorCredentials({
      provider: 'gmail',
      fromAddress: 'gmail.sender@example.com',
      host: null,
      port: null,
      tlsMode: 'starttls',
      authType: 'oauth2',
      authConfig: {
        authType: 'oauth2',
      },
    }),
    /requires an access token or refresh token/i,
  );
});

await test('sendThroughConnector sends via SMTP envelope and includes canonical recipients', async () => {
  await withMockedTransportFactory(
    [{}],
    async (stubs) => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-1',
              user_id: 'user-1',
              display_name: 'Sender',
              email_address: 'sender@example.com',
              signature: 'Best,\nSender',
              reply_to: 'reply@example.com',
              sent_to_incoming_connector_id: null,
            }],
          },
          {
            rows: [{
              id: 'outgoing-1',
              user_id: 'user-1',
              provider: 'smtp',
              host: 'smtp.example.com',
              port: 587,
              tls_mode: 'starttls',
              auth_config: {
                authType: 'password',
                username: 'sender@example.com',
                password: 'secret',
              },
              sent_copy_behavior: {},
              from_envelope_defaults: {},
            }],
          },
        ],
        async () => {
          const result = await sendThroughConnector('user-1', 'identity-1', {
            to: 'Alice <alice@example.com>',
            cc: ['bob@example.com'],
            bcc: ['carol@example.com'],
            subject: 'Subject',
            bodyText: 'Body text',
            bodyHtml: '<p>Body html</p>',
          });
          assert.equal(result.accepted, true);
          assert.match(String(result.messageId), /^<.+>$/);
          assert.equal(result.sentCopyError, null);
        },
      );

      assert.equal(stubs.length, 1);
      assert.equal(stubs[0].sendCalls.length, 1);
      assert.equal(stubs[0].sendCalls[0].envelope.from, 'sender@example.com');
      assert.deepEqual(stubs[0].sendCalls[0].envelope.to, [
        'alice@example.com',
        'bob@example.com',
        'carol@example.com',
      ]);
      assert.equal(stubs[0].closeCalls, 1);
    },
  );
});

await test('sendThroughConnector maps attachment payloads and rejects invalid identity email addresses', async () => {
  await withMockedTransportFactory(
    [{}],
    async (stubs) => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-attach',
              user_id: 'user-attach',
              display_name: 'Attach Sender',
              email_address: 'sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: null,
            }],
          },
          {
            rows: [{
              id: 'outgoing-attach',
              user_id: 'user-attach',
              provider: 'smtp',
              host: 'smtp.example.com',
              port: 587,
              tls_mode: 'weird-mode',
              auth_config: {
                authType: 'password',
                username: 'sender@example.com',
                password: 'secret',
              },
              sent_copy_behavior: {},
              from_envelope_defaults: {},
            }],
          },
        ],
        async () => {
          const result = await sendThroughConnector('user-attach', 'identity-attach', {
            to: 'recipient@example.com',
            subject: 'Attachment mapping',
            bodyText: 'Body',
            attachments: [
              {
                filename: 'inline.txt',
                contentType: 'text/plain',
                contentBase64: Buffer.from('inline content').toString('base64'),
                inline: true,
                contentId: 'cid-inline',
              },
              {
                filename: 'regular.txt',
                contentType: 'text/plain',
                contentBase64: Buffer.from('regular content').toString('base64'),
              },
            ],
          });
          assert.equal(result.accepted, true);
        },
      );

      assert.equal(stubs.length, 1);
      assert.equal(stubs[0].options.requireTLS, true);
      const raw = stubs[0].sendCalls[0].raw.toString('utf8');
      assert.match(raw, /Content-ID:\s*<cid-inline>/i);
      assert.match(raw, /aW5saW5lIGNvbnRlbnQ=/);
      assert.match(raw, /cmVndWxhciBjb250ZW50/);
    },
  );

  await withMockedTransportFactory(
    [{}],
    async () => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-invalid-email',
              user_id: 'user-invalid-email',
              display_name: 'Bad Sender',
              email_address: 'not-an-email',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: null,
            }],
          },
          {
            rows: [{
              id: 'outgoing-invalid-email',
              user_id: 'user-invalid-email',
              provider: 'smtp',
              host: 'smtp.example.com',
              port: 587,
              tls_mode: 'starttls',
              auth_config: {
                authType: 'password',
                username: 'sender@example.com',
                password: 'secret',
              },
              sent_copy_behavior: {},
              from_envelope_defaults: {},
            }],
          },
        ],
        async () => {
          await assert.rejects(
            sendThroughConnector('user-invalid-email', 'identity-invalid-email', {
              to: 'recipient@example.com',
              subject: 'Invalid sender',
              bodyText: 'Body',
            }),
            /identity email address is invalid/i,
          );
        },
      );
    },
  );
});

await test('sendThroughConnector surfaces MailComposer build failures', async () => {
  await withMockedMailComposerBuild(
    (cb) => cb(new Error('mail build failed'), null),
    async () => {
      await withMockedTransportFactory(
        [{}],
        async () => {
          await withMockedQueries(
            [
              {
                rows: [{
                  id: 'identity-build-fail',
                  user_id: 'user-build-fail',
                  display_name: 'Sender',
                  email_address: 'sender@example.com',
                  signature: '',
                  reply_to: null,
                  sent_to_incoming_connector_id: null,
                }],
              },
              {
                rows: [{
                  id: 'outgoing-build-fail',
                  user_id: 'user-build-fail',
                  provider: 'smtp',
                  host: 'smtp.example.com',
                  port: 587,
                  tls_mode: 'starttls',
                  auth_config: {
                    authType: 'password',
                    username: 'sender@example.com',
                    password: 'secret',
                  },
                  sent_copy_behavior: {},
                  from_envelope_defaults: {},
                }],
              },
            ],
            async () => {
              await assert.rejects(
                sendThroughConnector('user-build-fail', 'identity-build-fail', {
                  to: 'recipient@example.com',
                  subject: 'Build failure',
                  bodyText: 'Body',
                }),
                /mail build failed/i,
              );
            },
          );
        },
      );
    },
  );
});

await test('sendThroughConnector retries recoverable SMTP errors with backoff and then succeeds', async () => {
  const transientError = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });

  await withInstantTimers(async () => {
    await withMockedTransportFactory(
      [{ sendError: transientError }, {}],
      async (stubs) => {
        await withMockedQueries(
          [
            {
              rows: [{
                id: 'identity-2',
                user_id: 'user-2',
                display_name: 'Sender',
                email_address: 'sender@example.com',
                signature: '',
                reply_to: null,
                sent_to_incoming_connector_id: null,
              }],
            },
            {
              rows: [{
                id: 'outgoing-2',
                user_id: 'user-2',
                provider: 'smtp',
                host: 'smtp.example.com',
                port: 587,
                tls_mode: 'starttls',
                auth_config: {
                  authType: 'password',
                  username: 'sender@example.com',
                  password: 'secret',
                },
                sent_copy_behavior: {},
                from_envelope_defaults: {},
              }],
            },
          ],
          async () => {
            const result = await sendThroughConnector('user-2', 'identity-2', {
              to: 'to@example.com',
              subject: 'Retry Test',
              bodyText: 'Body',
            });
            assert.equal(result.accepted, true);
          },
        );

        assert.equal(stubs.length, 2);
        assert.equal(stubs[0].sendCalls.length, 1);
        assert.equal(stubs[1].sendCalls.length, 1);
        assert.equal(stubs[0].closeCalls, 1);
        assert.equal(stubs[1].closeCalls, 1);
      },
    );
  });
});

await test('sendThroughConnector fails after max recoverable SMTP retries are exhausted', async () => {
  const transientError = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });

  await withInstantTimers(async () => {
    await withMockedTransportFactory(
      [{ sendError: transientError }, { sendError: transientError }, { sendError: transientError }, { sendError: transientError }],
      async (stubs) => {
        await withMockedQueries(
          [
            {
              rows: [{
                id: 'identity-2b',
                user_id: 'user-2b',
                display_name: 'Sender',
                email_address: 'sender@example.com',
                signature: '',
                reply_to: null,
                sent_to_incoming_connector_id: null,
              }],
            },
            {
              rows: [{
                id: 'outgoing-2b',
                user_id: 'user-2b',
                provider: 'smtp',
                host: 'smtp.example.com',
                port: 587,
                tls_mode: 'starttls',
                auth_config: {
                  authType: 'password',
                  username: 'sender@example.com',
                  password: 'secret',
                },
                sent_copy_behavior: {},
                from_envelope_defaults: {},
              }],
            },
          ],
          async () => {
            await assert.rejects(
              sendThroughConnector('user-2b', 'identity-2b', {
                to: 'to@example.com',
                subject: 'Retry Exhausted',
                bodyText: 'Body',
              }),
              /timed out/i,
            );
          },
        );

        assert.equal(stubs.length, 4);
      },
    );
  });
});

await test('sendThroughConnector rejects when no valid recipients exist after parsing', async () => {
  await withMockedTransportFactory(
    [{}],
    async () => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-3',
              user_id: 'user-3',
              display_name: 'Sender',
              email_address: 'sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: null,
            }],
          },
          {
            rows: [{
              id: 'outgoing-3',
              user_id: 'user-3',
              provider: 'smtp',
              host: 'smtp.example.com',
              port: 587,
              tls_mode: 'starttls',
              auth_config: {
                authType: 'password',
                username: 'sender@example.com',
                password: 'secret',
              },
              sent_copy_behavior: {},
              from_envelope_defaults: {},
            }],
          },
        ],
        async () => {
          await assert.rejects(
            sendThroughConnector('user-3', 'identity-3', {
              to: '   ',
              cc: ['\n'],
              bcc: ['\r'],
              subject: 'Invalid recipients',
              bodyText: 'Body',
            }),
            /at least one recipient is required/i,
          );
        },
      );
    },
  );
});

await test('sendThroughConnector sends through Gmail API and infers thread from in-reply-to message id', async () => {
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  await withMockedFetch(
    (url, init) => {
      fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ id: 'gmail-send-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    async () => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-4',
              user_id: 'user-4',
              display_name: 'Gmail Sender',
              email_address: 'gmail.sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: null,
            }],
          },
          {
            rows: [{
              id: 'outgoing-4',
              user_id: 'user-4',
              provider: 'gmail',
              host: null,
              port: null,
              tls_mode: 'starttls',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access-4',
                refreshToken: 'refresh-4',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
              sent_copy_behavior: {},
              from_envelope_defaults: {},
            }],
          },
          {
            rows: [{ gmail_thread_id: 'gmail-thread-1' }],
            check: (call) => {
              assert.match(call.text, /LOWER\(COALESCE\(m\.message_id/);
            },
          },
          {
            rows: [],
            check: (call) => {
              assert.match(call.text, /FROM incoming_connectors/);
            },
          },
        ],
        async () => {
          const result = await sendThroughConnector('user-4', 'identity-4', {
            to: 'recipient@example.com',
            subject: 'Gmail API path',
            bodyText: 'Body',
            inReplyTo: '<parent@example.com>',
          });
          assert.equal(result.accepted, true);
          assert.equal(result.threadTag, 'gmail-thread-1');
        },
      );
    },
  );

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/);
  assert.match(String((fetchCalls[0].init?.headers as any)?.Authorization), /^Bearer /);
});

await test('sendThroughConnector resolves Gmail thread by references and local thread fallback', async () => {
  const fetchBodies: any[] = [];

  await withMockedFetch(
    async (_url, init) => {
      fetchBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ id: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    async () => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-5',
              user_id: 'user-5',
              display_name: 'Gmail Sender',
              email_address: 'gmail.sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: null,
            }],
          },
          {
            rows: [{
              id: 'outgoing-5',
              user_id: 'user-5',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access-5',
                refreshToken: 'refresh-5',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
              sent_copy_behavior: {},
              from_envelope_defaults: {},
            }],
          },
          {
            rows: [
              { gmail_thread_id: 'gmail-thread-ref', message_id: 'a@example.com' },
              { gmail_thread_id: 'gmail-thread-ref', message_id: 'b@example.com' },
            ],
          },
          { rows: [] },
          {
            rows: [{
              id: 'identity-6',
              user_id: 'user-6',
              display_name: 'Gmail Sender',
              email_address: 'gmail.sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: null,
            }],
          },
          {
            rows: [{
              id: 'outgoing-6',
              user_id: 'user-6',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access-6',
                refreshToken: 'refresh-6',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
              sent_copy_behavior: {},
              from_envelope_defaults: {},
            }],
          },
          {
            rows: [{ gmail_thread_id: 'gmail-thread-local' }],
            check: (call) => {
              assert.match(call.text, /m\.thread_id = \$2/);
              assert.equal(call.params[1], 'local-thread-1');
            },
          },
          { rows: [] },
        ],
        async () => {
          const byReferences = await sendThroughConnector('user-5', 'identity-5', {
            to: 'recipient@example.com',
            subject: 'References thread',
            bodyText: 'Body',
            references: '<x@example.com> <b@example.com>',
          });
          assert.equal(byReferences.threadTag, 'gmail-thread-ref');

          const byLocalThread = await sendThroughConnector('user-6', 'identity-6', {
            to: 'recipient@example.com',
            subject: 'Local thread fallback',
            bodyText: 'Body',
            threadId: 'local-thread-1',
          });
          assert.equal(byLocalThread.threadTag, 'gmail-thread-local');
        },
      );
    },
  );

  assert.equal(fetchBodies.length, 2);
  assert.equal(fetchBodies[0].threadId, 'gmail-thread-ref');
  assert.equal(fetchBodies[1].threadId, 'gmail-thread-local');
});

await test('sendThroughConnector enforces sent-copy connector requirements for IMAP append modes', async () => {
  await withMockedTransportFactory(
    [{}],
    async () => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-7',
              user_id: 'user-7',
              display_name: 'Sender',
              email_address: 'sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: null,
            }],
          },
          {
            rows: [{
              id: 'outgoing-7',
              user_id: 'user-7',
              provider: 'smtp',
              host: 'smtp.example.com',
              port: 587,
              tls_mode: 'starttls',
              auth_config: {
                authType: 'password',
                username: 'sender@example.com',
                password: 'secret',
              },
              sent_copy_behavior: { mode: 'imap_append' },
              from_envelope_defaults: {},
            }],
          },
        ],
        async () => {
          await assert.rejects(
            sendThroughConnector('user-7', 'identity-7', {
              to: 'recipient@example.com',
              subject: 'Sent copy required',
              bodyText: 'Body',
            }),
            /No incoming connector configured for sent-copy append/i,
          );
        },
      );
    },
  );

  await withMockedTransportFactory(
    [{}],
    async () => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-8',
              user_id: 'user-8',
              display_name: 'Sender',
              email_address: 'sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: 'incoming-8',
            }],
          },
          {
            rows: [{
              id: 'outgoing-8',
              user_id: 'user-8',
              provider: 'smtp',
              host: 'smtp.example.com',
              port: 587,
              tls_mode: 'starttls',
              auth_config: {
                authType: 'password',
                username: 'sender@example.com',
                password: 'secret',
              },
              sent_copy_behavior: { mode: 'imap_append' },
              from_envelope_defaults: {},
            }],
          },
          { rows: [] },
        ],
        async () => {
          await assert.rejects(
            sendThroughConnector('user-8', 'identity-8', {
              to: 'recipient@example.com',
              subject: 'Missing connector',
              bodyText: 'Body',
            }),
            /Configured sent-copy incoming connector no longer exists/i,
          );
        },
      );
    },
  );
});

await test('sendThroughConnector captures IMAP append failures as sentCopyError without failing send', async () => {
  await withMockedTransportFactory(
    [{}],
    async () => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-9',
              user_id: 'user-9',
              display_name: 'Sender',
              email_address: 'sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: 'incoming-9',
            }],
          },
          {
            rows: [{
              id: 'outgoing-9',
              user_id: 'user-9',
              provider: 'smtp',
              host: 'smtp.example.com',
              port: 587,
              tls_mode: 'starttls',
              auth_config: {
                authType: 'password',
                username: 'sender@example.com',
                password: 'secret',
              },
              sent_copy_behavior: { mode: 'imap_append_preferred', mailbox: 'Sent' },
              from_envelope_defaults: {},
            }],
          },
          {
            rows: [{
              id: 'incoming-9',
              user_id: 'user-9',
              provider: 'imap',
            }],
          },
          {
            rows: [],
          },
        ],
        async () => {
          const result = await sendThroughConnector('user-9', 'identity-9', {
            to: 'recipient@example.com',
            subject: 'Append fallback',
            bodyText: 'Body',
          });
          assert.equal(result.accepted, true);
          assert.match(String(result.sentCopyError), /Incoming connector not found/i);
        },
      );
    },
  );
});

await test('sendThroughConnector swallows enqueueSync failures for Gmail sent-sync follow-up', async () => {
  await withMockedFetch(
    () => new Response(JSON.stringify({ id: 'gmail-ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await withMockedQueries(
        [
          {
            rows: [{
              id: 'identity-10',
              user_id: 'user-10',
              display_name: 'Gmail Sender',
              email_address: 'gmail.sender@example.com',
              signature: '',
              reply_to: null,
              sent_to_incoming_connector_id: 'incoming-sync-10',
            }],
          },
          {
            rows: [{
              id: 'outgoing-10',
              user_id: 'user-10',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access-10',
                refreshToken: 'refresh-10',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
              sent_copy_behavior: {},
              from_envelope_defaults: {},
            }],
          },
        ],
        async () => {
          const result = await sendThroughConnector('user-10', 'identity-10', {
            to: 'recipient@example.com',
            subject: 'Gmail sent sync',
            bodyText: 'Body',
          });
          assert.equal(result.accepted, true);
          assert.equal(result.threadTag, null);
        },
      );
    },
  );
});

await test('sendThroughConnector swallows enqueueSync failures after successful IMAP sent-copy append', async () => {
  await withMockedImapFlowMethods(
    {
      connect: async function connect() {},
      logout: async function logout() {},
      mailboxOpen: async function mailboxOpen() {
        return { uidValidity: '1' };
      },
      append: async function append() {},
    },
    async () => {
      await withMockedTransportFactory(
        [{}],
        async () => {
          await withMockedQueries(
            [
              {
                rows: [{
                  id: 'identity-11',
                  user_id: 'user-11',
                  display_name: 'Sender',
                  email_address: 'sender@example.com',
                  signature: '',
                  reply_to: null,
                  sent_to_incoming_connector_id: 'incoming-11',
                }],
              },
              {
                rows: [{
                  id: 'outgoing-11',
                  user_id: 'user-11',
                  provider: 'smtp',
                  host: 'smtp.example.com',
                  port: 587,
                  tls_mode: 'starttls',
                  auth_config: {
                    authType: 'password',
                    username: 'sender@example.com',
                    password: 'secret',
                  },
                  sent_copy_behavior: { mode: 'imap_append_preferred', mailbox: 'Sent' },
                  from_envelope_defaults: {},
                }],
              },
              {
                rows: [{
                  id: 'incoming-11',
                  user_id: 'user-11',
                  provider: 'imap',
                  host: '127.0.0.1',
                  port: 143,
                  email_address: 'imap@example.com',
                  auth_config: { authType: 'password', password: 'secret' },
                }],
              },
              {
                rows: [{
                  id: 'incoming-11',
                  user_id: 'user-11',
                  provider: 'imap',
                  host: '127.0.0.1',
                  port: 143,
                  email_address: 'imap@example.com',
                  auth_config: { authType: 'password', password: 'secret' },
                }],
              },
            ],
            async () => {
              const result = await sendThroughConnector('user-11', 'identity-11', {
                to: 'recipient@example.com',
                subject: 'IMAP append + enqueue failure',
                bodyText: 'Body',
              });
              assert.equal(result.accepted, true);
              assert.equal(result.sentCopyError, null);
            },
          );
        },
      );
    },
  );
});

await test('sendThroughConnector refreshes OAuth auth on recoverable token errors and eventually fails at max attempts', async () => {
  const tokenTimeoutError = Object.assign(new Error('token temporary failure'), { responseCode: 451 });

  await withInstantTimers(async () => {
    await withMockedOAuthRefresh(
      async () => ({
        credentials: {},
      }),
      async () => {
        await withMockedFetch(
          async () => {
            throw tokenTimeoutError;
          },
          async () => {
            await withMockedQueries(
              [
                {
                  rows: [{
                    id: 'identity-12',
                    user_id: 'user-12',
                    display_name: 'Gmail Sender',
                    email_address: 'gmail.sender@example.com',
                    signature: '',
                    reply_to: null,
                    sent_to_incoming_connector_id: null,
                  }],
                },
                {
                  rows: [{
                    id: 'outgoing-12',
                    user_id: 'user-12',
                    provider: 'gmail',
                    auth_config: {
                      authType: 'oauth2',
                      accessToken: 'access-12',
                      refreshToken: 'refresh-12',
                      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                    },
                    sent_copy_behavior: {},
                    from_envelope_defaults: {},
                  }],
                },
              ],
              async () => {
                await assert.rejects(
                  sendThroughConnector('user-12', 'identity-12', {
                    to: 'recipient@example.com',
                    subject: 'OAuth refresh retry',
                    bodyText: 'Body',
                  }),
                  /token temporary/i,
                );
              },
            );
          },
        );
      },
    );
  });
});

await test('sendThroughConnector fails fast on fatal OAuth refresh errors', async () => {
  const fatalOauthError = Object.assign(new Error('invalid_grant temporary auth failure'), { responseCode: 451 });

  await withInstantTimers(async () => {
    await withMockedFetch(
      async () => {
        throw fatalOauthError;
      },
      async () => {
        await withMockedQueries(
          [
            {
              rows: [{
                id: 'identity-13',
                user_id: 'user-13',
                display_name: 'Gmail Sender',
                email_address: 'gmail.sender@example.com',
                signature: '',
                reply_to: null,
                sent_to_incoming_connector_id: null,
              }],
            },
            {
              rows: [{
                id: 'outgoing-13',
                user_id: 'user-13',
                provider: 'gmail',
                auth_config: {
                  authType: 'oauth2',
                  accessToken: 'access-13',
                  refreshToken: 'refresh-13',
                  tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                },
                sent_copy_behavior: {},
                from_envelope_defaults: {},
              }],
            },
          ],
          async () => {
            await assert.rejects(
              sendThroughConnector('user-13', 'identity-13', {
                to: 'recipient@example.com',
                subject: 'Fatal OAuth',
                bodyText: 'Body',
              }),
              /invalid_grant/i,
            );
          },
        );
      },
    );
  });
});

await test('sendThroughConnector refreshes expiring Gmail OAuth token before send attempt', async () => {
  let refreshCalls = 0;

  await withMockedOAuthRefresh(
    async () => {
      refreshCalls += 1;
      return { credentials: {} };
    },
    async () => {
      await withMockedFetch(
        () => new Response(JSON.stringify({ id: 'gmail-send-ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        async () => {
          await withMockedQueries(
            [
              {
                rows: [{
                  id: 'identity-14',
                  user_id: 'user-14',
                  display_name: 'Gmail Sender',
                  email_address: 'gmail.sender@example.com',
                  signature: '',
                  reply_to: null,
                  sent_to_incoming_connector_id: null,
                }],
              },
              {
                rows: [{
                  id: 'outgoing-14',
                  user_id: 'user-14',
                  provider: 'gmail',
                  auth_config: {
                    authType: 'oauth2',
                    accessToken: 'access-14',
                    refreshToken: 'refresh-14',
                    tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
                  },
                  sent_copy_behavior: {},
                  from_envelope_defaults: {},
                }],
              },
              { rows: [] },
            ],
            async () => {
              const result = await sendThroughConnector('user-14', 'identity-14', {
                to: 'recipient@example.com',
                subject: 'Expiring token',
                bodyText: 'Body',
              });
              assert.equal(result.accepted, true);
            },
          );
        },
      );
    },
  );

  assert.ok(refreshCalls >= 1, `expected oauth refresh call, got ${refreshCalls}`);
});

await test('sendThroughConnector swallows enqueueSync failure after IMAP append success', async () => {
  await withMockedQueueAddJob(
    async () => {
      throw new Error('enqueue failed');
    },
    async () => {
      await withMockedImapFlowMethods(
        {
          connect: async function connect() {},
          logout: async function logout() {},
          mailboxOpen: async function mailboxOpen() {
            return { uidValidity: '1' };
          },
          append: async function append() {},
        },
        async () => {
          await withMockedTransportFactory(
            [{}],
            async () => {
              await withMockedQueries(
                [
                  {
                    rows: [{
                      id: 'identity-15',
                      user_id: 'user-15',
                      display_name: 'Sender',
                      email_address: 'sender@example.com',
                      signature: '',
                      reply_to: null,
                      sent_to_incoming_connector_id: 'incoming-15',
                    }],
                  },
                  {
                    rows: [{
                      id: 'outgoing-15',
                      user_id: 'user-15',
                      provider: 'smtp',
                      host: 'smtp.example.com',
                      port: 587,
                      tls_mode: 'starttls',
                      auth_config: {
                        authType: 'password',
                        username: 'sender@example.com',
                        password: 'secret',
                      },
                      sent_copy_behavior: { mode: 'imap_append_preferred', mailbox: 'Sent' },
                      from_envelope_defaults: {},
                    }],
                  },
                  {
                    rows: [{
                      id: 'incoming-15',
                      user_id: 'user-15',
                      provider: 'imap',
                      host: '127.0.0.1',
                      port: 143,
                      email_address: 'imap@example.com',
                      auth_config: { authType: 'password', password: 'secret' },
                    }],
                  },
                  {
                    rows: [{
                      id: 'incoming-15',
                      user_id: 'user-15',
                      provider: 'imap',
                      host: '127.0.0.1',
                      port: 143,
                      email_address: 'imap@example.com',
                      auth_config: { authType: 'password', password: 'secret' },
                    }],
                  },
                  {
                    rows: [],
                    check: (call) => assert.match(call.text, /DELETE FROM graphile_worker\.jobs/),
                  },
                  {
                    rows: [],
                    check: (call) => assert.match(call.text, /FROM sync_states/),
                  },
                  {
                    rows: [{ count: 1 }],
                    check: (call) => assert.match(call.text, /graphile_worker\.workers/),
                  },
                ],
                async () => {
                  const result = await withMockedDateNow(
                    Date.now() + 10_000_000,
                    async () => sendThroughConnector('user-15', 'identity-15', {
                      to: 'recipient@example.com',
                      subject: 'Enqueue swallow (imap append)',
                      bodyText: 'Body',
                    }),
                  );
                  assert.equal(result.accepted, true);
                  assert.equal(result.sentCopyError, null);
                },
              );
            },
          );
        },
      );
    },
  );
});

await test('sendThroughConnector swallows Gmail sent-sync enqueue failures', async () => {
  await withMockedQueueAddJob(
    async () => {
      throw new Error('enqueue failed');
    },
    async () => {
      await withMockedFetch(
        () => new Response(JSON.stringify({ id: 'gmail-ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        async () => {
          await withMockedQueries(
            [
              {
                rows: [{
                  id: 'identity-16',
                  user_id: 'user-16',
                  display_name: 'Gmail Sender',
                  email_address: 'gmail.sender@example.com',
                  signature: '',
                  reply_to: null,
                  sent_to_incoming_connector_id: 'incoming-16',
                }],
              },
              {
                rows: [{
                  id: 'outgoing-16',
                  user_id: 'user-16',
                  provider: 'gmail',
                  auth_config: {
                    authType: 'oauth2',
                    accessToken: 'access-16',
                    refreshToken: 'refresh-16',
                    tokenExpiresAt: new Date(Date.now() + 100_000_000).toISOString(),
                  },
                  sent_copy_behavior: {},
                  from_envelope_defaults: {},
                }],
              },
              {
                rows: [],
                check: (call) => assert.match(call.text, /DELETE FROM graphile_worker\.jobs/),
              },
              {
                rows: [],
                check: (call) => assert.match(call.text, /FROM sync_states/),
              },
              {
                rows: [{ count: 1 }],
                check: (call) => assert.match(call.text, /graphile_worker\.workers/),
              },
            ],
            async () => {
              const result = await withMockedDateNow(
                Date.now() + 20_000_000,
                async () => sendThroughConnector('user-16', 'identity-16', {
                  to: 'recipient@example.com',
                  subject: 'Enqueue swallow (gmail)',
                  bodyText: 'Body',
                }),
              );
              assert.equal(result.accepted, true);
            },
          );
        },
      );
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
env.allowPrivateNetworkTargets = originalAllowPrivateTargets;
if (failed > 0) {
  process.exit(1);
}
