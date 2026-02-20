import assert from 'node:assert/strict';
import { pool } from '../../db/pool.js';
import {
  createIdentity,
  createIncomingConnector,
  createOutgoingConnector,
  deleteIdentity,
  deleteIncomingConnector,
  deleteOutgoingConnector,
  ensureIdentityOwnership,
  getIdentity,
  getIdentityById,
  getIncomingConnector,
  getIncomingConnectorById,
  getOutgoingConnector,
  getOutgoingConnectorById,
  listIdentities,
  listIncomingConnectors,
  listOutgoingConnectors,
  updateIdentity,
  updateIncomingConnector,
  updateIncomingConnectorAuth,
  updateOutgoingConnector,
  updateOutgoingConnectorAuth,
} from '../connectorService.js';

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
  fn: (calls: QueryCall[]) => Promise<void> | void,
) => {
  const calls: QueryCall[] = [];
  const originalQuery = pool.query.bind(pool);
  let index = 0;

  (pool as any).query = async (text: string, params: any[] = []) => {
    const call: QueryCall = { text: String(text), params: Array.isArray(params) ? params : [] };
    calls.push(call);

    const step = steps[index];
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
    await fn(calls);
    assert.equal(index, steps.length, `Expected ${steps.length} query calls, got ${index}`);
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

await test('lists and fetches incoming connectors', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'inc-1' }],
        check: (call) => {
          assert.match(call.text, /FROM incoming_connectors/);
          assert.deepEqual(call.params, ['user-1']);
        },
      },
      {
        rows: [{ id: 'inc-2' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['inc-2', 'user-1']);
        },
      },
      {
        rows: [],
        check: (call) => {
          assert.equal(call.text, 'SELECT * FROM incoming_connectors WHERE id = $1');
          assert.deepEqual(call.params, ['missing']);
        },
      },
    ],
    async () => {
      assert.deepEqual(await listIncomingConnectors('user-1'), [{ id: 'inc-1' }]);
      assert.deepEqual(await getIncomingConnector('user-1', 'inc-2'), { id: 'inc-2' });
      assert.equal(await getIncomingConnectorById('missing'), null);
    },
  );
});

await test('updates incoming connectors with dynamic fields and supports no-op payload', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.match(call.text, /UPDATE incoming_connectors SET/);
          assert.match(call.text, /name = \$3/);
          assert.match(call.text, /email_address = \$4/);
          assert.match(call.text, /host = \$5/);
          assert.match(call.text, /port = \$6/);
          assert.match(call.text, /tls = \$7/);
          assert.match(call.text, /auth_config = \$8::jsonb/);
          assert.match(call.text, /sync_settings = \$9::jsonb/);
          assert.match(call.text, /visual_config = \$10::jsonb/);
          assert.match(call.text, /status = \$11/);
          assert.deepEqual(call.params, [
            'inc-1',
            'user-1',
            'Primary',
            'owner@example.com',
            'imap.example.com',
            993,
            true,
            JSON.stringify({ authType: 'password' }),
            JSON.stringify({ mailbox: 'INBOX' }),
            JSON.stringify({ color: '#fff' }),
            'healthy',
          ]);
        },
      },
    ],
    async (calls) => {
      await updateIncomingConnector('user-1', 'inc-1', {
        name: 'Primary',
        emailAddress: 'owner@example.com',
        host: 'imap.example.com',
        port: 993,
        tls: true,
        authConfig: { authType: 'password' },
        syncSettings: { mailbox: 'INBOX' },
        visual_config: { color: '#fff' },
        status: 'healthy',
      });
      assert.equal(calls.length, 1);
    },
  );

  await withMockedQueries([], async () => {
    await updateIncomingConnector('user-1', 'inc-1', {});
  });
});

await test('creates incoming connector with defaults and updates auth with optional user guard', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'inc-created' }],
        check: (call) => {
          assert.match(call.text, /INSERT INTO incoming_connectors/);
          assert.match(String(call.params[0]), /^[0-9a-f-]{36}$/i);
          assert.equal(call.params[1], 'user-1');
          assert.equal(call.params[7], true);
          assert.deepEqual(JSON.parse(String(call.params[8])), { authType: 'password', password: 'secret' });
          assert.deepEqual(JSON.parse(String(call.params[9])), {});
          assert.deepEqual(JSON.parse(String(call.params[10])), {});
        },
      },
      {
        check: (call) => {
          assert.equal(
            call.text,
            'UPDATE incoming_connectors SET auth_config = $2::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $3',
          );
          assert.deepEqual(call.params, ['inc-created', JSON.stringify({ authType: 'oauth2' }), 'user-1']);
        },
      },
      {
        check: (call) => {
          assert.equal(
            call.text,
            'UPDATE incoming_connectors SET auth_config = $2::jsonb, updated_at = NOW() WHERE id = $1',
          );
          assert.deepEqual(call.params, ['inc-created', JSON.stringify({ authType: 'password' })]);
        },
      },
    ],
    async () => {
      const created = await createIncomingConnector('user-1', {
        name: 'Primary',
        emailAddress: 'owner@example.com',
        provider: 'imap',
        authType: 'password',
        authConfig: { password: 'secret' },
      });
      assert.deepEqual(created, { id: 'inc-created' });

      await updateIncomingConnectorAuth('inc-created', { authType: 'oauth2' }, 'user-1');
      await updateIncomingConnectorAuth('inc-created', { authType: 'password' });
    },
  );
});

await test('deleteIncomingConnector runs transactional cleanup and rolls back on failure', async () => {
  const originalConnect = pool.connect.bind(pool);
  const happyCalls: Array<{ text: string; params?: any[] }> = [];
  let releasedHappy = false;

  (pool as any).connect = async () => ({
    query: async (text: string, params?: any[]) => {
      happyCalls.push({ text: String(text), params });
      return { rows: [] };
    },
    release: () => {
      releasedHappy = true;
    },
  });

  try {
    await deleteIncomingConnector('user-1', 'inc-1');
    assert.equal(happyCalls[0]?.text, 'BEGIN');
    assert.match(happyCalls[1]?.text ?? '', /DELETE FROM oauth_states/);
    assert.deepEqual(happyCalls[1]?.params, ['user-1', 'inc-1']);
    assert.match(happyCalls[2]?.text ?? '', /DELETE FROM incoming_connectors/);
    assert.deepEqual(happyCalls[2]?.params, ['inc-1', 'user-1']);
    assert.equal(happyCalls[3]?.text, 'COMMIT');
    assert.equal(releasedHappy, true);
  } finally {
    (pool as any).connect = originalConnect;
  }

  const rollbackCalls: Array<{ text: string; params?: any[] }> = [];
  let releasedRollback = false;
  (pool as any).connect = async () => ({
    query: async (text: string, params?: any[]) => {
      rollbackCalls.push({ text: String(text), params });
      if (String(text).includes('DELETE FROM incoming_connectors')) {
        throw new Error('delete incoming failed');
      }
      return { rows: [] };
    },
    release: () => {
      releasedRollback = true;
    },
  });

  try {
    await assert.rejects(
      deleteIncomingConnector('user-1', 'inc-1'),
      /delete incoming failed/,
    );
    assert.equal(rollbackCalls.some((call) => call.text === 'ROLLBACK'), true);
    assert.equal(releasedRollback, true);
  } finally {
    (pool as any).connect = originalConnect;
  }
});

await test('lists, fetches, updates, and auth-updates outgoing connectors', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'out-1' }],
        check: (call) => {
          assert.match(call.text, /FROM outgoing_connectors/);
          assert.deepEqual(call.params, ['user-1']);
        },
      },
      {
        rows: [{ id: 'out-2' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT * FROM outgoing_connectors WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['out-2', 'user-1']);
        },
      },
      {
        rows: [{ id: 'out-3' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT * FROM outgoing_connectors WHERE id = $1');
          assert.deepEqual(call.params, ['out-3']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /UPDATE outgoing_connectors SET/);
          assert.match(call.text, /name = \$3/);
          assert.match(call.text, /from_address = \$4/);
          assert.match(call.text, /tls_mode = \$7/);
          assert.match(call.text, /auth_config = \$8::jsonb/);
          assert.match(call.text, /from_envelope_defaults = \$9::jsonb/);
          assert.match(call.text, /sent_copy_behavior = \$10::jsonb/);
          assert.deepEqual(call.params, [
            'out-2',
            'user-1',
            'SMTP',
            'sender@example.com',
            'smtp.example.com',
            587,
            'starttls',
            JSON.stringify({ authType: 'password' }),
            JSON.stringify({ bounce: 'bounce@example.com' }),
            JSON.stringify({ mode: 'always' }),
          ]);
        },
      },
      {
        check: (call) => {
          assert.equal(
            call.text,
            'UPDATE outgoing_connectors SET auth_config = $2::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $3',
          );
          assert.deepEqual(call.params, ['out-2', JSON.stringify({ authType: 'oauth2' }), 'user-1']);
        },
      },
    ],
    async () => {
      assert.deepEqual(await listOutgoingConnectors('user-1'), [{ id: 'out-1' }]);
      assert.deepEqual(await getOutgoingConnector('user-1', 'out-2'), { id: 'out-2' });
      assert.deepEqual(await getOutgoingConnectorById('out-3'), { id: 'out-3' });
      await updateOutgoingConnector('user-1', 'out-2', {
        name: 'SMTP',
        fromAddress: 'sender@example.com',
        host: 'smtp.example.com',
        port: 587,
        tlsMode: 'starttls',
        authConfig: { authType: 'password' },
        fromEnvelopeDefaults: { bounce: 'bounce@example.com' },
        sentCopyBehavior: { mode: 'always' },
      });
      await updateOutgoingConnectorAuth('out-2', { authType: 'oauth2' }, 'user-1');
    },
  );

  await withMockedQueries([], async () => {
    await updateOutgoingConnector('user-1', 'out-2', {});
  });
});

await test('creates outgoing connector with default tls/auth settings', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'out-created' }],
        check: (call) => {
          assert.match(call.text, /INSERT INTO outgoing_connectors/);
          assert.match(String(call.params[0]), /^[0-9a-f-]{36}$/i);
          assert.equal(call.params[1], 'user-1');
          assert.equal(call.params[7], 'starttls');
          assert.deepEqual(JSON.parse(String(call.params[8])), { authType: 'password' });
          assert.deepEqual(JSON.parse(String(call.params[9])), {});
          assert.deepEqual(JSON.parse(String(call.params[10])), {});
        },
      },
    ],
    async () => {
      const created = await createOutgoingConnector('user-1', {
        name: 'Outbound',
        provider: 'smtp',
        fromAddress: 'sender@example.com',
      });
      assert.deepEqual(created, { id: 'out-created' });
    },
  );
});

await test('deleteOutgoingConnector runs transactional cleanup and rolls back on failure', async () => {
  const originalConnect = pool.connect.bind(pool);
  const happyCalls: Array<{ text: string; params?: any[] }> = [];
  let releasedHappy = false;

  (pool as any).connect = async () => ({
    query: async (text: string, params?: any[]) => {
      happyCalls.push({ text: String(text), params });
      return { rows: [] };
    },
    release: () => {
      releasedHappy = true;
    },
  });

  try {
    await deleteOutgoingConnector('user-1', 'out-1');
    assert.equal(happyCalls[0]?.text, 'BEGIN');
    assert.match(happyCalls[1]?.text ?? '', /DELETE FROM oauth_states/);
    assert.match(happyCalls[2]?.text ?? '', /DELETE FROM send_idempotency/);
    assert.match(happyCalls[3]?.text ?? '', /DELETE FROM identities/);
    assert.match(happyCalls[4]?.text ?? '', /DELETE FROM outgoing_connectors/);
    assert.equal(happyCalls[5]?.text, 'COMMIT');
    assert.equal(releasedHappy, true);
  } finally {
    (pool as any).connect = originalConnect;
  }

  const rollbackCalls: Array<{ text: string; params?: any[] }> = [];
  let releasedRollback = false;
  (pool as any).connect = async () => ({
    query: async (text: string, params?: any[]) => {
      rollbackCalls.push({ text: String(text), params });
      if (String(text).includes('DELETE FROM identities')) {
        throw new Error('delete identities failed');
      }
      return { rows: [] };
    },
    release: () => {
      releasedRollback = true;
    },
  });

  try {
    await assert.rejects(
      deleteOutgoingConnector('user-1', 'out-1'),
      /delete identities failed/,
    );
    assert.equal(rollbackCalls.some((call) => call.text === 'ROLLBACK'), true);
    assert.equal(releasedRollback, true);
  } finally {
    (pool as any).connect = originalConnect;
  }
});

await test('creates, lists, fetches, updates, and deletes identities with ownership checks', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'out-1' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT id FROM outgoing_connectors WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['out-1', 'user-1']);
        },
      },
      {
        rows: [{ id: 'inc-1' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT id FROM incoming_connectors WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['inc-1', 'user-1']);
        },
      },
      {
        rows: [{ id: 'id-created' }],
        check: (call) => {
          assert.match(call.text, /INSERT INTO identities/);
          assert.match(String(call.params[0]), /^[0-9a-f-]{36}$/i);
          assert.equal(call.params[1], 'user-1');
          assert.equal(call.params[2], 'Primary Sender');
          assert.equal(call.params[3], 'sender@example.com');
          assert.equal(call.params[5], 'out-1');
          assert.equal(call.params[6], 'inc-1');
          assert.equal(call.params[7], 'reply@example.com');
          assert.deepEqual(JSON.parse(String(call.params[8])), { avatar: 'A' });
        },
      },
      {
        rows: [{ id: 'id-created' }],
        check: (call) => {
          assert.match(call.text, /FROM identities/);
          assert.deepEqual(call.params, ['user-1']);
        },
      },
      {
        rows: [{ id: 'id-created' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT * FROM identities WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['id-created', 'user-1']);
        },
      },
      {
        rows: [{ id: 'id-created' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT * FROM identities WHERE id = $1');
          assert.deepEqual(call.params, ['id-created']);
        },
      },
      {
        rows: [{ id: 'id-created' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT id FROM identities WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['id-created', 'user-1']);
        },
      },
      {
        rows: [{ id: 'out-2' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT id FROM outgoing_connectors WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['out-2', 'user-1']);
        },
      },
      {
        rows: [{ id: 'inc-2' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT id FROM incoming_connectors WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['inc-2', 'user-1']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /UPDATE identities SET/);
          assert.match(call.text, /display_name = \$3/);
          assert.match(call.text, /email_address = \$4/);
          assert.match(call.text, /signature = \$5/);
          assert.match(call.text, /outgoing_connector_id = \$6/);
          assert.match(call.text, /sent_to_incoming_connector_id = \$7/);
          assert.match(call.text, /reply_to = \$8/);
          assert.match(call.text, /visual_config = \$9::jsonb/);
          assert.deepEqual(call.params, [
            'id-created',
            'user-1',
            'Renamed',
            'sender2@example.com',
            'Best regards',
            'out-2',
            'inc-2',
            'reply2@example.com',
            JSON.stringify({ avatar: 'B' }),
          ]);
        },
      },
      {
        check: (call) => {
          assert.equal(call.text, 'DELETE FROM identities WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['id-created', 'user-1']);
        },
      },
    ],
    async () => {
      const created = await createIdentity(
        'user-1',
        'Primary Sender',
        'sender@example.com',
        'out-1',
        'Thanks',
        'inc-1',
        'reply@example.com',
        { avatar: 'A' },
      );
      assert.deepEqual(created, { id: 'id-created' });
      assert.deepEqual(await listIdentities('user-1'), [{ id: 'id-created' }]);
      assert.deepEqual(await getIdentity('user-1', 'id-created'), { id: 'id-created' });
      assert.deepEqual(await getIdentityById('id-created'), { id: 'id-created' });
      await updateIdentity('user-1', 'id-created', {
        displayName: 'Renamed',
        emailAddress: 'sender2@example.com',
        signature: 'Best regards',
        outgoingConnectorId: 'out-2',
        sentToIncomingConnectorId: 'inc-2',
        replyTo: 'reply2@example.com',
        visual_config: { avatar: 'B' },
      });
      await deleteIdentity('user-1', 'id-created');
    },
  );
});

await test('enforces identity ownership and connector ownership constraints', async () => {
  await withMockedQueries(
    [
      {
        rows: [],
        check: (call) => {
          assert.equal(call.text, 'SELECT id FROM identities WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['identity-1', 'user-1']);
        },
      },
      {
        rows: [{ id: 'identity-2' }],
      },
      {
        rows: [],
        check: (call) => {
          assert.equal(call.text, 'SELECT id FROM outgoing_connectors WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['out-missing', 'user-1']);
        },
      },
    ],
    async () => {
      await assert.rejects(
        ensureIdentityOwnership('user-1', 'identity-1'),
        /identity not found/,
      );

      await assert.rejects(
        updateIdentity('user-1', 'identity-2', { outgoingConnectorId: 'out-missing' }),
        /outgoing connector not found/,
      );
    },
  );
});

await test('skips UPDATE for identity when payload has no mutable fields', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'identity-3' }],
        check: (call) => {
          assert.equal(call.text, 'SELECT id FROM identities WHERE id = $1 AND user_id = $2');
          assert.deepEqual(call.params, ['identity-3', 'user-1']);
        },
      },
    ],
    async () => {
      await updateIdentity('user-1', 'identity-3', {});
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
