import assert from 'node:assert/strict';
import { ImapFlow } from 'imapflow';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import {
  applyThreadMessageActions,
  appendMessageToMailbox,
  deleteMessageFromMailbox,
  getImapClient,
  hydrateGmailMailboxContentBatch,
  listConnectorMailboxes,
  moveMessageInMailbox,
  reapStaleSyncStates,
  requestSyncCancellation,
  resumeConfiguredIdleWatches,
  runIdleWatchdog,
  setMessageReadState,
  setMessageStarredState,
  startIncomingConnectorIdleWatch,
  stopIncomingConnectorIdleWatch,
  syncIncomingConnector,
} from '../imap.js';
import { createQueue } from '../queue.js';

type QueryCall = {
  text: string;
  params: any[];
};

const withMockedQueryHandler = async (
  handler: (call: QueryCall) => Promise<any[]> | any[],
  fn: (calls: QueryCall[]) => Promise<void> | void,
) => {
  const originalQuery = pool.query.bind(pool);
  const calls: QueryCall[] = [];

  (pool as any).query = async (text: string, params: any[] = []) => {
    const call: QueryCall = { text: String(text), params: Array.isArray(params) ? params : [] };
    calls.push(call);
    const rows = await handler(call);
    return { rows: rows ?? [] };
  };

  try {
    await fn(calls);
  } finally {
    (pool as any).query = originalQuery;
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

const withMockedQueueAddJob = async (
  fn: (calls: Array<{ task: string; payload: Record<string, any>; options: Record<string, any> }>) => Promise<void> | void,
) => {
  const queue = await createQueue();
  const originalAddJob = (queue as any).addJob;
  const calls: Array<{ task: string; payload: Record<string, any>; options: Record<string, any> }> = [];

  (queue as any).addJob = async (task: string, payload: Record<string, any>, options: Record<string, any>) => {
    calls.push({ task, payload, options });
  };

  try {
    await fn(calls);
  } finally {
    (queue as any).addJob = originalAddJob;
  }
};

const syncStateColumns = [
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
];

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

await test('listConnectorMailboxes rejects unknown connector', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('FROM incoming_connectors')) {
        return [];
      }
      return [];
    },
    async () => {
      await assert.rejects(
        listConnectorMailboxes('user-1', 'missing-connector'),
        /not found/i,
      );
    },
  );
});

await test('listConnectorMailboxes for Gmail maps labels and appends All Mail fallback', async () => {
  await withMockedFetch(
    (_url, _init) => new Response(JSON.stringify({
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'SENT', name: 'SENT', type: 'system' },
        { id: 'Project-X', name: 'Project X', type: 'user' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text.includes('FROM incoming_connectors')) {
            return [{
              id: 'connector-gmail',
              user_id: 'user-1',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access-1',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            }];
          }
          return [];
        },
        async () => {
          const mailboxes = await listConnectorMailboxes('user-1', 'connector-gmail');
          const paths = mailboxes.map((mailbox) => mailbox.path);
          assert.deepEqual(paths, ['INBOX', 'SENT', 'Project-X', 'ALL']);
        },
      );
    },
  );
});

await test('listConnectorMailboxes for generic IMAP connectors maps server mailbox metadata', async () => {
  const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
  env.allowPrivateNetworkTargets = true;

  const observed: Array<{ op: string; args: any[] }> = [];

  await withMockedImapFlowMethods(
    {
      connect: async function connect() {
        observed.push({ op: 'connect', args: [] });
      },
      logout: async function logout() {
        observed.push({ op: 'logout', args: [] });
      },
      list: async function list() {
        observed.push({ op: 'list', args: [] });
        return [
          {
            path: 'INBOX',
            name: 'Inbox',
            delimiter: '/',
            flags: new Set(['\\Inbox']),
            subscribed: true,
            specialUse: '\\Inbox',
          },
          {
            path: 'Archive/2026',
            name: '2026',
            delimiter: '/',
            flags: new Set(),
            subscribed: false,
            specialUse: null,
          },
        ];
      },
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text.includes('FROM incoming_connectors')) {
            return [{
              id: 'connector-imap-list',
              user_id: 'user-imap',
              provider: 'imap',
              host: '127.0.0.1',
              port: 143,
              email_address: 'imap@example.com',
              auth_config: {
                authType: 'password',
                password: 'secret',
              },
              sync_settings: {},
            }];
          }
          return [];
        },
        async () => {
          const mailboxes = await listConnectorMailboxes('user-imap', 'connector-imap-list');
          assert.equal(mailboxes.length, 2);
          assert.equal(mailboxes[0].path, 'INBOX');
          assert.deepEqual(mailboxes[0].flags, ['\\Inbox']);
          assert.equal(mailboxes[1].path, 'Archive/2026');
          assert.equal(mailboxes[1].specialUse, null);
        },
      );
    },
  );

  env.allowPrivateNetworkTargets = originalAllowPrivateTargets;
  assert.ok(observed.some((entry) => entry.op === 'connect'));
  assert.ok(observed.some((entry) => entry.op === 'list'));
  assert.ok(observed.some((entry) => entry.op === 'logout'));
});

await test('listConnectorMailboxes for Gmail-over-IMAP canonicalizes and filters duplicate container rows', async () => {
  const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
  env.allowPrivateNetworkTargets = true;

  await withMockedImapFlowMethods(
    {
      connect: async function connect() {},
      logout: async function logout() {},
      list: async function list() {
        return [
          { path: '[Gmail]', name: '[Gmail]', delimiter: '/', specialUse: null, subscribed: false },
          { path: '[Gmail]/All Mail', name: 'All Mail', delimiter: '/', specialUse: '\\All', subscribed: true },
          { path: '[Gmail]/Spam', name: 'Spam', delimiter: '/', specialUse: '\\Junk', subscribed: true },
          { path: '[Google Mail]/Spam', name: 'Spam Duplicate', delimiter: '/', specialUse: '\\Junk', subscribed: true },
          { path: '[Gmail]/Starred', name: 'Starred', delimiter: '/', specialUse: '\\Flagged', subscribed: true },
        ];
      },
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text.includes('FROM incoming_connectors')) {
            return [{
              id: 'connector-gmail-imap-list',
              user_id: 'user-gimap',
              provider: 'imap',
              host: '127.0.0.1',
              port: 143,
              email_address: 'gmail-imap@example.com',
              auth_config: {
                authType: 'password',
                password: 'secret',
              },
              sync_settings: { gmailImap: true },
            }];
          }
          return [];
        },
        async () => {
          const mailboxes = await listConnectorMailboxes('user-gimap', 'connector-gmail-imap-list');
          const paths = mailboxes.map((mailbox) => mailbox.path);
          assert.deepEqual(paths, ['ALL', 'SPAM', 'STARRED']);
        },
      );
    },
  );

  env.allowPrivateNetworkTargets = originalAllowPrivateTargets;
});

await test('listConnectorMailboxes for Gmail-over-IMAP drops empty and duplicate canonical rows', async () => {
  const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
  env.allowPrivateNetworkTargets = true;

  await withMockedImapFlowMethods(
    {
      connect: async function connect() {},
      logout: async function logout() {},
      list: async function list() {
        return [
          { path: '', name: '', delimiter: '/', specialUse: null, subscribed: false },
          { path: '[Gmail]/Starred', name: 'Starred', delimiter: '/', specialUse: '\\Flagged', subscribed: true },
          { path: '[Google Mail]/Starred', name: 'Starred Duplicate', delimiter: '/', specialUse: '\\Flagged', subscribed: true },
          { path: '[Gmail]/All Mail', name: 'All Mail', delimiter: '/', specialUse: '\\All', subscribed: true },
        ];
      },
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text.includes('FROM incoming_connectors')) {
            return [{
              id: 'connector-gmail-imap-filtering',
              user_id: 'user-gimap-filtering',
              provider: 'imap',
              host: '127.0.0.1',
              port: 143,
              email_address: 'gmail-imap@example.com',
              auth_config: {
                authType: 'password',
                password: 'secret',
              },
              sync_settings: { gmailImap: true },
            }];
          }
          return [];
        },
        async () => {
          const mailboxes = await listConnectorMailboxes('user-gimap-filtering', 'connector-gmail-imap-filtering');
          const paths = mailboxes.map((mailbox) => mailbox.path);
          assert.deepEqual(paths, ['STARRED', 'ALL']);
        },
      );
    },
  );

  env.allowPrivateNetworkTargets = originalAllowPrivateTargets;
});

await test('moveMessageInMailbox rejects archive destination aliases', async () => {
  await assert.rejects(
    moveMessageInMailbox('user-1', 'msg-1', 'connector-1', 'INBOX', 'ARCHIVE', 10),
    /archive is no longer supported/i,
  );
});

await test('appendMessageToMailbox resolves Gmail-IMAP mailbox paths and reuses cached mailbox directory', async () => {
  const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
  env.allowPrivateNetworkTargets = true;

  const openedMailboxes: string[] = [];
  let listCalls = 0;

  await withMockedImapFlowMethods(
    {
      connect: async function connect() {},
      logout: async function logout() {},
      list: async function list() {
        listCalls += 1;
        return [
          { path: 'All Mail', name: 'All Mail', delimiter: '/', specialUse: null, subscribed: true },
          { path: 'Custom/Folder', name: 'Custom Folder', delimiter: '/', specialUse: null, subscribed: true },
          { path: '[Gmail]/Spam', name: 'Spam', delimiter: '/', specialUse: '\\Junk', subscribed: true },
        ];
      },
      mailboxOpen: async function mailboxOpen(mailbox: string) {
        openedMailboxes.push(mailbox);
        return { uidValidity: '1' };
      },
      append: async function append() {},
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-gimap-append',
              user_id: 'user-gimap-append',
              provider: 'imap',
              host: '127.0.0.1',
              port: 143,
              email_address: 'imap@example.com',
              auth_config: { authType: 'password', password: 'secret' },
              sync_settings: { gmailImap: true },
            }];
          }
          return [];
        },
        async () => {
          await appendMessageToMailbox('user-gimap-append', 'connector-gimap-append', 'ALL', Buffer.from('raw-1'));
          await appendMessageToMailbox('user-gimap-append', 'connector-gimap-append', 'Custom/Folder', Buffer.from('raw-2'));
          await appendMessageToMailbox('user-gimap-append', 'connector-gimap-append', 'custom/folder', Buffer.from('raw-3'));
          await appendMessageToMailbox('user-gimap-append', 'connector-gimap-append', '', Buffer.from('raw-4'));
        },
      );
    },
  );

  env.allowPrivateNetworkTargets = originalAllowPrivateTargets;

  assert.deepEqual(openedMailboxes, ['All Mail', 'Custom/Folder', 'Custom/Folder', '']);
  assert.equal(listCalls, 1);
});

await test('moveMessageInMailbox updates Gmail labels and local folder state', async () => {
  await withMockedFetch(
    (_url, _init) => new Response(JSON.stringify({ labelIds: ['SENT', 'STARRED'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-1',
              user_id: 'user-1',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            }];
          }
          if (call.text.includes('SELECT m.incoming_connector_id')) {
            return [{ incoming_connector_id: 'connector-1' }];
          }
          if (call.text.includes('SELECT m.gmail_message_id')) {
            return [{
              gmail_message_id: 'gmail-1',
              folder_path: 'INBOX',
              is_read: false,
              is_starred: false,
              flags: [],
            }];
          }
          return [];
        },
        async (calls) => {
          await moveMessageInMailbox(
            'user-1',
            'message-1',
            'connector-1',
            'INBOX',
            'SENT',
            22,
          );

          const updateCall = calls.find((call) =>
            call.text.includes('UPDATE messages SET folder_path = $2'));
          assert.ok(updateCall, 'expected folder update query');
          assert.deepEqual(updateCall?.params, [
            'message-1',
            'SENT',
            ['SENT', 'STARRED'],
            true,
            true,
          ]);
        },
      );
    },
  );
});

await test('setMessageReadState rolls back optimistic update when Gmail label modify fails', async () => {
  await withMockedFetch(
    () => new Response('upstream error', {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'text/plain' },
    }),
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-2',
              user_id: 'user-2',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            }];
          }
          if (call.text.includes('SELECT m.incoming_connector_id')) {
            return [{ incoming_connector_id: 'connector-2' }];
          }
          if (call.text.includes('SELECT m.gmail_message_id')) {
            return [{
              gmail_message_id: 'gmail-2',
              folder_path: 'INBOX',
              is_read: false,
              is_starred: true,
              flags: ['STARRED', 'UNREAD'],
            }];
          }
          return [];
        },
        async (calls) => {
          await assert.rejects(
            setMessageReadState('user-2', 'message-2', 'connector-2', 'INBOX', 11, true),
            /Gmail API 400/i,
          );

          const updates = calls.filter((call) => call.text.includes('UPDATE messages SET is_read'));
          assert.ok(updates.length >= 2, `expected optimistic + rollback updates, got ${updates.length}`);
          assert.deepEqual(updates[0].params, ['message-2', true, ['STARRED']]);
          assert.deepEqual(updates[updates.length - 1].params, ['message-2', false, true, ['STARRED', 'UNREAD']]);
        },
      );
    },
  );
});

await test('setMessageStarredState applies Gmail labels and persists resolved starred state', async () => {
  await withMockedFetch(
    () => new Response(JSON.stringify({ labelIds: ['STARRED', 'INBOX'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-3',
              user_id: 'user-3',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            }];
          }
          if (call.text.includes('SELECT m.incoming_connector_id')) {
            return [{ incoming_connector_id: 'connector-3' }];
          }
          if (call.text.includes('SELECT m.gmail_message_id')) {
            return [{
              gmail_message_id: 'gmail-3',
              folder_path: 'INBOX',
              is_read: true,
              is_starred: false,
              flags: ['INBOX'],
            }];
          }
          return [];
        },
        async (calls) => {
          await setMessageStarredState('user-3', 'message-3', 'connector-3', 'INBOX', 12, true);
          const optimistic = calls.find((call) => call.text.includes('UPDATE messages SET is_starred = $2, flags = $3'));
          assert.ok(optimistic, 'expected optimistic starred update');
          assert.deepEqual(optimistic?.params, ['message-3', true, ['INBOX', 'STARRED']]);
          const resolved = calls.find((call) => call.text.includes('UPDATE messages SET is_starred = $2, is_read = $3, flags = $4'));
          assert.ok(resolved, 'expected resolved starred update');
          assert.deepEqual(resolved?.params, ['message-3', true, true, ['STARRED', 'INBOX']]);
        },
      );
    },
  );
});

await test('deleteMessageFromMailbox trashes Gmail message then removes local row', async () => {
  await withMockedFetch(
    (_url, _init) => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-4',
              user_id: 'user-4',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            }];
          }
          if (call.text.includes('SELECT m.incoming_connector_id')) {
            return [{ incoming_connector_id: 'connector-4' }];
          }
          if (call.text.includes('SELECT m.gmail_message_id')) {
            return [{
              gmail_message_id: 'gmail-4',
              folder_path: 'INBOX',
              is_read: true,
              is_starred: false,
              flags: ['INBOX'],
            }];
          }
          return [];
        },
        async (calls) => {
          await deleteMessageFromMailbox('user-4', 'message-4', 'connector-4', 'INBOX', 20);
          const deleteCall = calls.find((call) => call.text === 'DELETE FROM messages WHERE id = $1');
          assert.ok(deleteCall, 'expected local message delete query');
          assert.deepEqual(deleteCall?.params, ['message-4']);
        },
      );
    },
  );
});

await test('appendMessageToMailbox opens mailbox and appends via IMAP connector', async () => {
  const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
  env.allowPrivateNetworkTargets = true;

  const operations: Array<{ op: string; args: any[] }> = [];
  await withMockedImapFlowMethods(
    {
      connect: async function connect() {
        operations.push({ op: 'connect', args: [] });
      },
      logout: async function logout() {
        operations.push({ op: 'logout', args: [] });
      },
      mailboxOpen: async function mailboxOpen(path: string) {
        operations.push({ op: 'mailboxOpen', args: [path] });
        return { path };
      },
      append: async function append(path: string, raw: Buffer, flags: string[]) {
        operations.push({ op: 'append', args: [path, raw.toString('utf8'), flags] });
      },
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-append',
              user_id: 'user-append',
              provider: 'imap',
              host: '127.0.0.1',
              port: 143,
              email_address: 'imap@example.com',
              auth_config: { authType: 'password', password: 'secret' },
            }];
          }
          return [];
        },
        async () => {
          await appendMessageToMailbox('user-append', 'connector-append', 'Sent', Buffer.from('hello'));
        },
      );
    },
  );

  env.allowPrivateNetworkTargets = originalAllowPrivateTargets;
  assert.deepEqual(
    operations.map((operation) => operation.op),
    ['connect', 'mailboxOpen', 'append', 'logout'],
  );
});

await test('move/setRead/setStar/delete execute IMAP operations for non-gmail connectors', async () => {
  const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
  env.allowPrivateNetworkTargets = true;

  const operations: Array<{ op: string; args: any[] }> = [];

  await withMockedImapFlowMethods(
    {
      connect: async function connect() {
        operations.push({ op: 'connect', args: [] });
      },
      logout: async function logout() {
        operations.push({ op: 'logout', args: [] });
      },
      mailboxOpen: async function mailboxOpen(path: string) {
        operations.push({ op: 'mailboxOpen', args: [path] });
        return { path };
      },
      messageMove: async function messageMove(uid: string, destination: string) {
        operations.push({ op: 'messageMove', args: [uid, destination] });
      },
      messageFlagsAdd: async function messageFlagsAdd(uid: string, flags: string[]) {
        operations.push({ op: 'messageFlagsAdd', args: [uid, flags] });
      },
      messageFlagsRemove: async function messageFlagsRemove(uid: string, flags: string[]) {
        operations.push({ op: 'messageFlagsRemove', args: [uid, flags] });
      },
      messageDelete: async function messageDelete(uid: string) {
        operations.push({ op: 'messageDelete', args: [uid] });
      },
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-imap-actions',
              user_id: 'user-imap-actions',
              provider: 'imap',
              host: '127.0.0.1',
              port: 143,
              email_address: 'imap@example.com',
              auth_config: { authType: 'password', password: 'secret' },
              sync_settings: {},
            }];
          }
          if (call.text.includes('SELECT m.incoming_connector_id')) {
            return [{ incoming_connector_id: 'connector-imap-actions' }];
          }
          if (call.text.includes('SELECT m.gmail_message_id')) {
            return [{
              gmail_message_id: null,
              folder_path: 'INBOX',
              is_read: false,
              is_starred: false,
              flags: [],
            }];
          }
          if (call.text.includes('SELECT is_starred FROM messages WHERE id = $1')) {
            return [{ is_starred: false }];
          }
          return [];
        },
        async () => {
          await moveMessageInMailbox(
            'user-imap-actions',
            'msg-imap-1',
            'connector-imap-actions',
            'INBOX',
            'Archive',
            101,
          );
          await setMessageReadState(
            'user-imap-actions',
            'msg-imap-1',
            'connector-imap-actions',
            'Archive',
            101,
            true,
          );
          await setMessageStarredState(
            'user-imap-actions',
            'msg-imap-1',
            'connector-imap-actions',
            'Archive',
            101,
            true,
          );
          await deleteMessageFromMailbox(
            'user-imap-actions',
            'msg-imap-1',
            'connector-imap-actions',
            'Archive',
            101,
          );
        },
      );
    },
  );

  env.allowPrivateNetworkTargets = originalAllowPrivateTargets;

  assert.ok(operations.some((entry) => entry.op === 'messageMove'));
  assert.ok(operations.some((entry) => entry.op === 'messageFlagsAdd'));
  assert.ok(operations.some((entry) => entry.op === 'messageDelete'));
});

await test('applyThreadMessageActions executes move and delete actions across thread messages', async () => {
  await withMockedFetch(
    (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/modify')) {
        return new Response(JSON.stringify({ labelIds: ['SENT'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (parsed.pathname.endsWith('/trash')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected Gmail API URL: ${url}`);
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text.includes('SELECT m.thread_id,')) {
            return [{ thread_id: 'thread-apply', incoming_connector_id: 'connector-thread' }];
          }
          if (call.text.includes('WHERE m.thread_id = $1')) {
            return [
              { id: 'thread-msg-1', incoming_connector_id: 'connector-thread', folder_path: 'INBOX', uid: 11 },
              { id: 'thread-msg-2', incoming_connector_id: 'connector-thread', folder_path: 'INBOX', uid: 12 },
            ];
          }
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-thread',
              user_id: 'user-thread',
              provider: 'gmail',
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access-thread',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            }];
          }
          if (call.text.includes('SELECT m.incoming_connector_id')) {
            return [{ incoming_connector_id: 'connector-thread' }];
          }
          if (call.text.includes('SELECT m.gmail_message_id')) {
            return [{
              gmail_message_id: 'gmail-thread-message',
              folder_path: 'INBOX',
              is_read: false,
              is_starred: false,
              flags: [],
            }];
          }
          return [];
        },
        async (calls) => {
          await applyThreadMessageActions('user-thread', 'thread-msg-1', {
            isRead: true,
            isStarred: true,
            moveToFolder: 'SENT',
            delete: true,
          });
          const moveCalls = calls.filter((call) => call.text.includes('UPDATE messages SET folder_path = $2'));
          const deleteCalls = calls.filter((call) => call.text === 'DELETE FROM messages WHERE id = $1');
          assert.equal(moveCalls.length, 2);
          assert.equal(deleteCalls.length, 2);
        },
      );
    },
  );
});

await test('applyThreadMessageActions applies add/remove label key actions across thread messages', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('SELECT m.thread_id,')) {
        return [{ thread_id: 'thread-labels', incoming_connector_id: 'connector-thread-labels' }];
      }
      if (call.text.includes('WHERE m.thread_id = $1')) {
        return [
          { id: 'thread-label-msg-1', incoming_connector_id: 'connector-thread-labels', folder_path: 'INBOX', uid: 101 },
          { id: 'thread-label-msg-2', incoming_connector_id: 'connector-thread-labels', folder_path: 'INBOX', uid: 102 },
        ];
      }
      if (call.text.includes('INSERT INTO message_labels')) {
        return [];
      }
      if (call.text.includes('DELETE FROM message_labels ml')) {
        return [];
      }
      return [];
    },
    async (calls) => {
      await applyThreadMessageActions('user-thread-labels', 'thread-label-msg-1', {
        addLabelKeys: ['project_alpha'],
        removeLabelKeys: ['old_tag'],
      });

      const addCalls = calls.filter((call) => call.text.includes('INSERT INTO message_labels'));
      const removeCalls = calls.filter((call) => call.text.includes('DELETE FROM message_labels ml'));
      assert.equal(addCalls.length, 2);
      assert.equal(removeCalls.length, 2);
      assert.deepEqual(addCalls.map((call) => call.params[2]), ['project_alpha', 'project_alpha']);
      assert.deepEqual(removeCalls.map((call) => call.params[1]), [['old_tag'], ['old_tag']]);
    },
  );
});

await test('applyThreadMessageActions rejects when thread message lookup returns no rows', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('SELECT m.thread_id,')) {
        return [{ thread_id: 'thread-empty', incoming_connector_id: 'connector-thread-empty' }];
      }
      if (call.text.includes('WHERE m.thread_id = $1')) {
        return [];
      }
      return [];
    },
    async () => {
      await assert.rejects(
        applyThreadMessageActions('user-thread-empty', 'thread-msg-empty', {
          isRead: true,
        }),
        /Thread not found/i,
      );
    },
  );
});

await test('reapStaleSyncStates handles missing schema gracefully', async () => {
  await withMockedQueryHandler(
    (_call) => {
      throw Object.assign(new Error('missing table'), { code: '42P01' });
    },
    async () => {
      const result = await reapStaleSyncStates();
      assert.deepEqual(result, { reaped: 0 });
    },
  );
});

await test('reapStaleSyncStates emits sync_error events for each stale state', async () => {
  const originalPushEnabled = env.push.enabled;
  env.push.enabled = false;

  let firstCall = true;
  await withMockedQueryHandler(
    (call) => {
      if (firstCall) {
        firstCall = false;
        assert.match(call.text, /UPDATE sync_states/);
        return [
          {
            incoming_connector_id: 'connector-a',
            mailbox: 'INBOX',
            status: 'syncing',
            sync_started_at: '2026-02-20T00:00:00.000Z',
            updated_at: '2026-02-20T00:05:00.000Z',
          },
          {
            incoming_connector_id: 'connector-b',
            mailbox: 'SENT',
            status: 'queued',
            sync_started_at: null,
            updated_at: '2026-02-20T00:10:00.000Z',
          },
        ];
      }
      if (call.text.includes('INSERT INTO sync_events')) {
        return [{ id: '1', user_id: 'user-x' }];
      }
      return [];
    },
    async (calls) => {
      const result = await reapStaleSyncStates();
      assert.deepEqual(result, { reaped: 2 });
      const emitCalls = calls.filter((call) => call.text.includes('INSERT INTO sync_events'));
      assert.equal(emitCalls.length, 2);
    },
  );

  env.push.enabled = originalPushEnabled;
});

await test('requestSyncCancellation rejects unknown connector', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('FROM incoming_connectors')) {
        return [];
      }
      return [];
    },
    async () => {
      await assert.rejects(
        requestSyncCancellation('user-x', 'missing-connector', 'INBOX'),
        /not found/i,
      );
    },
  );
});

await test('syncIncomingConnector rejects unknown connector before sync work starts', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('FROM incoming_connectors')) {
        return [];
      }
      return [];
    },
    async () => {
      await assert.rejects(
        syncIncomingConnector('user-x', 'missing-connector', 'INBOX'),
        /not found/i,
      );
    },
  );
});

await test('getImapClient enforces OAuth2 provider and required host/port validation', async () => {
  await assert.rejects(
    getImapClient({
      id: 'connector-oauth-invalid',
      provider: 'imap',
      email_address: 'user@example.com',
      host: 'imap.example.com',
      port: 993,
      auth_config: {
        authType: 'oauth2',
        accessToken: 'access',
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    }),
    /oauth2 incoming auth is currently only supported/i,
  );

  await assert.rejects(
    getImapClient({
      id: 'connector-host-missing',
      provider: 'imap',
      email_address: 'user@example.com',
      port: 993,
      auth_config: {
        authType: 'password',
        password: 'secret',
      },
    }),
    /host is required/i,
  );

  await assert.rejects(
    getImapClient({
      id: 'connector-port-invalid',
      provider: 'imap',
      email_address: 'user@example.com',
      host: 'imap.example.com',
      port: 70000,
      auth_config: {
        authType: 'password',
        password: 'secret',
      },
    }),
    /port must be an integer between 1 and 65535/i,
  );
});

await test('getImapClient builds password-auth config when connector input is valid', async () => {
  const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
  env.allowPrivateNetworkTargets = true;

  const client = await getImapClient({
    id: 'connector-valid',
    provider: 'imap',
    email_address: 'user@example.com',
    host: '127.0.0.1',
    port: 143,
    sync_settings: { imapTlsMode: 'starttls' },
    auth_config: {
      authType: 'password',
      password: 'secret',
    },
  });

  env.allowPrivateNetworkTargets = originalAllowPrivateTargets;

  assert.equal(typeof (client as any).connect, 'function');
  assert.equal(typeof (client as any).logout, 'function');
});

await test('syncIncomingConnector performs Gmail metadata bootstrap and enqueues hydration follow-up', async () => {
  const originalPushEnabled = env.push.enabled;
  const originalBootstrapMetadataOnly = env.sync.gmailBootstrapMetadataOnly;
  env.push.enabled = false;
  env.sync.gmailBootstrapMetadataOnly = true;

  const fetchHits: string[] = [];

  await withMockedQueueAddJob(async (jobCalls) => {
    await withMockedFetch(
      (url) => {
        fetchHits.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/profile')) {
          return new Response(JSON.stringify({ historyId: '222' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (parsed.pathname.endsWith('/messages') && parsed.searchParams.get('labelIds') === 'INBOX') {
          return new Response(JSON.stringify({ messages: [{ id: 'gmail-msg-1' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (parsed.pathname.endsWith('/messages/gmail-msg-1') && parsed.searchParams.get('format') === 'metadata') {
          return new Response(JSON.stringify({
            id: 'gmail-msg-1',
            threadId: 'gmail-thread-1',
            labelIds: ['INBOX', 'UNREAD'],
            historyId: '223',
            internalDate: String(Date.now()),
            snippet: 'snippet',
            payload: {
              headers: [
                { name: 'Message-ID', value: '<gmail-msg-1@example.com>' },
                { name: 'Subject', value: 'Subject 1' },
                { name: 'From', value: 'Sender <sender@example.com>' },
                { name: 'To', value: 'Recipient <recipient@example.com>' },
                { name: 'In-Reply-To', value: '<parent@example.com>' },
                { name: 'References', value: '<root@example.com> <parent@example.com>' },
              ],
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected Gmail API URL: ${url}`);
      },
      async () => {
        await withMockedQueryHandler(
          (call) => {
            if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
              return [{
                id: 'connector-gmail',
                user_id: 'user-gmail',
                provider: 'gmail',
                email_address: 'gmail@example.com',
                sync_settings: { gmailApiBootstrapped: true },
                auth_config: {
                  authType: 'oauth2',
                  accessToken: 'access-gmail',
                  tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                },
              }];
            }
            if (call.text.includes('FROM information_schema.columns')) {
              return syncStateColumns;
            }
            if (call.text.includes('SELECT COALESCE(last_seen_uid, 0) AS "lastSeenUid"')) {
              return [];
            }
            if (call.text.includes('SELECT status') && call.text.includes('FROM sync_states')) {
              return [];
            }
            if (call.text.includes('UPDATE sync_states') && call.text.includes('RETURNING incoming_connector_id')) {
              return [{ incoming_connector_id: 'connector-gmail' }];
            }
            if (call.text.includes('SELECT COUNT(*)::int as count') && call.text.includes('folder_path = $2')) {
              return [{ count: 0 }];
            }
            if (call.text.includes('FROM messages') && call.text.includes('gmail_thread_id = $2')) {
              return [];
            }
            if (call.text.includes('AND gmail_message_id = $3')) {
              return [];
            }
            if (call.text.includes('AND message_id = $3') && call.text.includes('gmail_message_id IS NULL')) {
              return [];
            }
            if (call.text.includes('INSERT INTO messages') && call.text.includes('gmail_message_id')) {
              return [{ id: 'local-msg-1' }];
            }
            if (call.text.includes('SET in_reply_to = COALESCE')) {
              return [];
            }
            if (call.text.includes('SELECT incoming_connector_id, gmail_message_id, message_id, in_reply_to')) {
              return [];
            }
            if (call.text.includes('DELETE FROM messages') && call.text.includes('gmail_message_id <> ALL')) {
              return [];
            }
            if (call.text.includes('INSERT INTO sync_events')) {
              return [{ id: '1', user_id: 'user-gmail' }];
            }
            return [];
          },
          async (calls) => {
            await syncIncomingConnector('user-gmail', 'connector-gmail', 'INBOX');
            const emitted = calls.filter((call) => call.text.includes('INSERT INTO sync_events'));
            assert.ok(emitted.length >= 2, `expected sync event emissions, got ${emitted.length}`);
          },
        );
      },
    );

    assert.equal(jobCalls.length, 1);
    assert.equal(jobCalls[0].task, 'hydrateGmailMailboxContent');
    assert.equal(jobCalls[0].payload.connectorId, 'connector-gmail');
    assert.equal(jobCalls[0].payload.mailbox, 'INBOX');
  });

  assert.ok(fetchHits.some((url) => url.includes('/profile')));
  assert.ok(fetchHits.some((url) => url.includes('/messages?')));
  assert.ok(fetchHits.some((url) => url.includes('/messages/gmail-msg-1')));

  env.push.enabled = originalPushEnabled;
  env.sync.gmailBootstrapMetadataOnly = originalBootstrapMetadataOnly;
});

await test('syncIncomingConnector falls back from stale Gmail history to full mailbox listing', async () => {
  const originalPushEnabled = env.push.enabled;
  const originalBootstrapMetadataOnly = env.sync.gmailBootstrapMetadataOnly;
  env.push.enabled = false;
  env.sync.gmailBootstrapMetadataOnly = false;

  await withMockedFetch(
    async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/profile')) {
        return new Response(JSON.stringify({ historyId: '600' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (parsed.pathname.endsWith('/history')) {
        return new Response('startHistoryId is too old', {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (parsed.pathname.endsWith('/messages')) {
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected Gmail API URL: ${url}`);
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-history',
              user_id: 'user-history',
              provider: 'gmail',
              email_address: 'history@example.com',
              sync_settings: { gmailApiBootstrapped: true },
              auth_config: {
                authType: 'oauth2',
                accessToken: 'access-history',
                tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            }];
          }
          if (call.text.includes('FROM information_schema.columns')) {
            return syncStateColumns;
          }
          if (call.text.includes('SELECT COALESCE(last_seen_uid, 0) AS "lastSeenUid"')) {
            return [{
              lastSeenUid: 0,
              highestUid: 0,
              uidvalidity: null,
              modseq: '500',
              lastFullReconcileAt: null,
              status: 'idle',
              syncStartedAt: null,
              syncCompletedAt: null,
              syncError: null,
              syncProgress: {},
            }];
          }
          if (call.text.includes('SELECT status') && call.text.includes('FROM sync_states')) {
            return [];
          }
          if (call.text.includes('UPDATE sync_states') && call.text.includes('RETURNING incoming_connector_id')) {
            return [{ incoming_connector_id: 'connector-history' }];
          }
          if (call.text.includes('SELECT COUNT(*)::int as count') && call.text.includes('folder_path = $2')) {
            return [{ count: 1 }];
          }
          if (call.text.includes('DELETE FROM messages') && call.text.includes('gmail_message_id IS NOT NULL')) {
            return [];
          }
          if (call.text.includes('INSERT INTO sync_events')) {
            return [{ id: '1', user_id: 'user-history' }];
          }
          return [];
        },
        async (calls) => {
          await syncIncomingConnector('user-history', 'connector-history', 'INBOX');
          const fallbackSignal = calls.find((call) =>
            call.text.includes('INSERT INTO sync_events')
            && String(call.params[2]).includes('gmail-history-fallback'));
          assert.ok(fallbackSignal, 'expected gmail-history-fallback sync_error event');
        },
      );
    },
  );

  env.push.enabled = originalPushEnabled;
  env.sync.gmailBootstrapMetadataOnly = originalBootstrapMetadataOnly;
});

await test('syncIncomingConnector executes IMAP mailbox sync flow with mocked client operations', async () => {
  const originalAllowPrivateTargets = env.allowPrivateNetworkTargets;
  env.allowPrivateNetworkTargets = true;

  const imapOps: Array<{ op: string; args: any[] }> = [];

  await withMockedImapFlowMethods(
    {
      connect: async function connect() {
        imapOps.push({ op: 'connect', args: [] });
      },
      logout: async function logout() {
        imapOps.push({ op: 'logout', args: [] });
      },
      mailboxOpen: async function mailboxOpen(path: string) {
        imapOps.push({ op: 'mailboxOpen', args: [path] });
        return {
          path,
          uidValidity: '1',
          highestModseq: '2',
          uidNext: 3,
        };
      },
      search: async function search(criteria: Record<string, any>) {
        imapOps.push({ op: 'search', args: [criteria] });
        return [1, 2];
      },
      fetch: function fetch(uids: number[] | string, requested: Record<string, any>) {
        imapOps.push({ op: 'fetch', args: [uids, requested] });
        const values = Array.isArray(uids) ? uids : [1, 2];
        const self = async function* iterator() {
          for (const uid of values) {
            yield {
              uid,
              envelope: {
                messageId: `<imap-${uid}@example.com>`,
                subject: `IMAP ${uid}`,
                from: [{ name: 'Sender', address: 'sender@example.com' }],
                to: [{ name: 'Recipient', address: 'recipient@example.com' }],
              },
              internalDate: new Date('2026-02-20T00:00:00.000Z'),
              flags: new Set(['\\Seen']),
            };
          }
        };
        return self();
      },
    },
    async () => {
      await withMockedQueryHandler(
        (call) => {
          if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
            return [{
              id: 'connector-imap-sync',
              user_id: 'user-imap-sync',
              provider: 'imap',
              host: '127.0.0.1',
              port: 143,
              email_address: 'imap@example.com',
              auth_config: { authType: 'password', password: 'secret' },
              sync_settings: {},
            }];
          }
          if (call.text.includes('FROM information_schema.columns')) {
            return syncStateColumns;
          }
          if (call.text.includes('SELECT COALESCE(last_seen_uid, 0) AS "lastSeenUid"')) {
            return [{
              lastSeenUid: 0,
              highestUid: 0,
              uidvalidity: null,
              modseq: null,
              lastFullReconcileAt: null,
              status: 'idle',
              syncStartedAt: null,
              syncCompletedAt: null,
              syncError: null,
              syncProgress: {},
            }];
          }
          if (call.text.includes('SELECT status') && call.text.includes('FROM sync_states')) {
            return [];
          }
          if (call.text.includes('UPDATE sync_states') && call.text.includes('RETURNING incoming_connector_id')) {
            return [{ incoming_connector_id: 'connector-imap-sync' }];
          }
          if (call.text.includes('SELECT id,') && call.text.includes('AND uid = $3')) {
            const uid = Number(call.params[2]);
            return [{ id: `local-${uid}`, has_body: true, has_raw: true }];
          }
          if (call.text.includes('UPDATE messages') && call.text.includes('RETURNING id')) {
            return [{ id: `local-${Number(call.params[2])}` }];
          }
          if (call.text.includes('SELECT id, uid, raw_blob_key')) {
            return [
              { id: 'local-1', uid: '1', raw_blob_key: null },
              { id: 'local-2', uid: '2', raw_blob_key: null },
            ];
          }
          if (call.text.includes('SELECT blob_key FROM attachments')) {
            return [];
          }
          if (call.text.includes('INSERT INTO sync_events')) {
            return [{ id: '1', user_id: 'user-imap-sync' }];
          }
          return [];
        },
        async () => {
          await syncIncomingConnector('user-imap-sync', 'connector-imap-sync', 'INBOX');
        },
      );
    },
  );

  env.allowPrivateNetworkTargets = originalAllowPrivateTargets;

  assert.ok(imapOps.some((entry) => entry.op === 'search'));
  assert.ok(imapOps.some((entry) => entry.op === 'fetch'));
  assert.ok(imapOps.some((entry) => entry.op === 'logout'));
});

await test('appendMessageToMailbox rejects unknown incoming connector', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('FROM incoming_connectors')) {
        return [];
      }
      return [];
    },
    async () => {
      await assert.rejects(
        appendMessageToMailbox('user-a', 'missing-connector', 'INBOX', Buffer.from('raw')),
        /Incoming connector not found/i,
      );
    },
  );
});

await test('hydrateGmailMailboxContentBatch returns empty result for non-gmail connectors', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
        return [{
          id: 'connector-imap',
          user_id: 'user-a',
          provider: 'imap',
        }];
      }
      return [];
    },
    async () => {
      const result = await hydrateGmailMailboxContentBatch('user-a', 'connector-imap', 'INBOX');
      assert.deepEqual(result, { processed: 0, failed: 0, remaining: 0 });
    },
  );
});

await test('hydrateGmailMailboxContentBatch reports zero progress when no rows need hydration', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
        return [{
          id: 'connector-gmail-hydrate',
          user_id: 'user-h',
          provider: 'gmail',
          auth_config: {
            authType: 'oauth2',
            accessToken: 'access',
            tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        }];
      }
      if (call.text.includes('FROM messages') && call.text.includes('LIMIT $3')) {
        return [];
      }
      if (call.text.includes('COUNT(*)::int as count')) {
        return [{ count: 0 }];
      }
      return [];
    },
    async () => {
      const result = await hydrateGmailMailboxContentBatch('user-h', 'connector-gmail-hydrate', 'INBOX', 25);
      assert.deepEqual(result, { processed: 0, failed: 0, remaining: 0 });
    },
  );
});

await test('syncIncomingConnector tolerates already-running mailbox sync claims', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
        return [{
          id: 'connector-busy',
          user_id: 'user-busy',
          provider: 'gmail',
          email_address: 'busy@example.com',
          sync_settings: { gmailApiBootstrapped: true },
          auth_config: {
            authType: 'oauth2',
            accessToken: 'access-busy',
            tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        }];
      }
      if (call.text.includes('FROM information_schema.columns')) {
        return syncStateColumns;
      }
      if (call.text.includes('SELECT COALESCE(last_seen_uid, 0) AS "lastSeenUid"')) {
        return [{
          lastSeenUid: 0,
          highestUid: 0,
          uidvalidity: null,
          modseq: null,
          lastFullReconcileAt: null,
          status: 'syncing',
          syncProgress: { inserted: 9 },
        }];
      }
      if (call.text.includes('SELECT status') && call.text.includes('FROM sync_states')) {
        return [];
      }
      if (call.text.includes('UPDATE sync_states') && call.text.includes('RETURNING incoming_connector_id')) {
        return [];
      }
      return [];
    },
    async (calls) => {
      await syncIncomingConnector('user-busy', 'connector-busy', 'INBOX');
      const errorPersist = calls.find((call) =>
        call.text.includes('UPDATE sync_states') && call.params.includes('error'));
      assert.equal(errorPersist, undefined);
    },
  );
});

await test('syncIncomingConnector handles cancellation sentinel and emits sync_cancelled event', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
        return [{
          id: 'connector-cancel',
          user_id: 'user-cancel',
          provider: 'gmail',
          email_address: 'cancel@example.com',
          sync_settings: { gmailApiBootstrapped: true },
          auth_config: {
            authType: 'oauth2',
            accessToken: 'access-cancel',
            tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        }];
      }
      if (call.text.includes('FROM information_schema.columns')) {
        return syncStateColumns;
      }
      if (call.text.includes('SELECT COALESCE(last_seen_uid, 0) AS "lastSeenUid"')) {
        return [{
          lastSeenUid: 0,
          highestUid: 0,
          uidvalidity: null,
          modseq: null,
          lastFullReconcileAt: null,
          status: 'cancel_requested',
          syncProgress: { inserted: 1 },
        }];
      }
      if (call.text.includes('SELECT status') && call.text.includes('FROM sync_states')) {
        return [{ status: 'cancel_requested' }];
      }
      if (call.text.includes('INSERT INTO sync_events')) {
        return [{ id: '1', user_id: 'user-cancel' }];
      }
      return [];
    },
    async (calls) => {
      await syncIncomingConnector('user-cancel', 'connector-cancel', 'INBOX');
      const cancelledEvent = calls.find((call) =>
        call.text.includes('INSERT INTO sync_events') && call.params[1] === 'sync_cancelled');
      assert.ok(cancelledEvent, 'expected sync_cancelled event');
      const cancelledStateUpdate = calls.find((call) =>
        call.text.includes('UPDATE sync_states') && call.params.includes('cancelled'));
      assert.ok(cancelledStateUpdate, 'expected cancelled sync_state update');
    },
  );
});

await test('syncIncomingConnector propagates unexpected sync errors after persisting error state', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
        return [{
          id: 'connector-error',
          user_id: 'user-error',
          provider: 'gmail',
          email_address: 'error@example.com',
          sync_settings: { gmailApiBootstrapped: true },
          auth_config: {
            authType: 'oauth2',
            accessToken: 'access-error',
            tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        }];
      }
      if (call.text.includes('FROM information_schema.columns')) {
        return syncStateColumns;
      }
      if (call.text.includes('SELECT COALESCE(last_seen_uid, 0) AS "lastSeenUid"')) {
        throw new Error('mailbox read failure');
      }
      return [];
    },
    async (calls) => {
      await assert.rejects(
        syncIncomingConnector('user-error', 'connector-error', 'INBOX'),
        /mailbox read failure/i,
      );
      const errorPersist = calls.find((call) =>
        call.text.includes('UPDATE sync_states') && call.params.includes('error'));
      assert.ok(errorPersist, 'expected error sync_state persistence');
    },
  );
});

await test('startIncomingConnectorIdleWatch skips Gmail polling when push watch is healthy', async () => {
  const originalPushEnabled = env.push.enabled;
  env.push.enabled = false;

  await withMockedQueryHandler(
    (call) => {
      if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
        return [{
          id: 'connector-watch',
          user_id: 'user-watch',
          provider: 'gmail',
          auth_config: { authType: 'oauth2', accessToken: 'access' },
          sync_settings: {
            gmailPush: {
              enabled: true,
              status: 'watching',
            },
          },
        }];
      }
      if (call.text.includes('INSERT INTO sync_events')) {
        return [{ id: '1', user_id: 'user-watch' }];
      }
      return [];
    },
    async (calls) => {
      await startIncomingConnectorIdleWatch('user-watch', 'connector-watch', 'INBOX');
      const skippedEvent = calls.find((call) =>
        call.text.includes('INSERT INTO sync_events') && call.params[1] === 'sync_info');
      assert.ok(skippedEvent, 'expected informational watch_skipped event');
    },
  );

  env.push.enabled = originalPushEnabled;
});

await test('startIncomingConnectorIdleWatch and stopIncomingConnectorIdleWatch reject unknown connectors', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('FROM incoming_connectors')) {
        return [];
      }
      return [];
    },
    async () => {
      await assert.rejects(
        startIncomingConnectorIdleWatch('user-watch', 'missing-connector', 'INBOX'),
        /not found/i,
      );
      await assert.rejects(
        stopIncomingConnectorIdleWatch('user-watch', 'missing-connector', 'INBOX'),
        /not found/i,
      );
    },
  );
});

await test('stopIncomingConnectorIdleWatch returns stopped when no watcher exists', async () => {
  await withMockedQueryHandler(
    (call) => {
      if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
        return [{
          id: 'connector-stop',
          user_id: 'user-stop',
          provider: 'gmail',
          sync_settings: { gmailPush: { enabled: true, status: 'watching' } },
        }];
      }
      return [];
    },
    async () => {
      const result = await stopIncomingConnectorIdleWatch('user-stop', 'connector-stop', 'INBOX');
      assert.deepEqual(result, { stopped: true });
    },
  );
});

await test('runIdleWatchdog reports zero watchers when idle map is empty', async () => {
  const result = await runIdleWatchdog();
  assert.equal(result.watched, 0);
  assert.equal(result.restarted, 0);
  assert.ok(result.staleMs > 0);
});

await test('resumeConfiguredIdleWatches returns early when idle mode is disabled', async () => {
  const originalUseIdle = env.sync.useIdle;
  env.sync.useIdle = false;
  const result = await resumeConfiguredIdleWatches();
  env.sync.useIdle = originalUseIdle;
  assert.deepEqual(result, { resumed: 0 });
});

await test('resumeConfiguredIdleWatches ignores connectors without configured mailboxes', async () => {
  const originalUseIdle = env.sync.useIdle;
  env.sync.useIdle = true;

  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('SELECT id, user_id, sync_settings')) {
        return [
          { id: 'connector-a', user_id: 'user-a', sync_settings: null },
          { id: 'connector-b', user_id: 'user-b', sync_settings: { watchMailboxes: [] } },
        ];
      }
      return [];
    },
    async () => {
      const result = await resumeConfiguredIdleWatches();
      assert.deepEqual(result, { resumed: 0 });
    },
  );

  env.sync.useIdle = originalUseIdle;
});

await test('resumeConfiguredIdleWatches sanitizes invalid/duplicate mailbox entries before resuming watchers', async () => {
  const originalUseIdle = env.sync.useIdle;
  env.sync.useIdle = true;

  await withMockedQueryHandler(
    (call) => {
      if (call.text.includes('SELECT id, user_id, sync_settings')) {
        return [
          {
            id: 'connector-resume-sanitize',
            user_id: 'user-resume-sanitize',
            provider: 'imap',
            sync_settings: {
              gmailImap: true,
              watchMailboxes: [
                'INBOX',
                '',
                'INBOX',
                'INBOX\u0001',
                'x'.repeat(513),
                '[Google Mail]/All Mail',
              ],
            },
          },
        ];
      }
      if (call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2') {
        return [{
          id: 'connector-resume-sanitize',
          user_id: 'user-resume-sanitize',
          provider: 'gmail',
          auth_config: { authType: 'oauth2', accessToken: 'access' },
          sync_settings: {
            gmailPush: {
              enabled: true,
              status: 'watching',
            },
          },
        }];
      }
      if (call.text.includes('INSERT INTO sync_events')) {
        return [{ id: '1', user_id: 'user-resume-sanitize' }];
      }
      return [];
    },
    async (calls) => {
      const result = await resumeConfiguredIdleWatches();
      assert.deepEqual(result, { resumed: 2 });

      const connectorLookups = calls.filter((call) =>
        call.text === 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2');
      assert.equal(connectorLookups.length, 2);
      assert.deepEqual(
        connectorLookups.map((call) => call.params[0]),
        ['connector-resume-sanitize', 'connector-resume-sanitize'],
      );
    },
  );

  env.sync.useIdle = originalUseIdle;
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
