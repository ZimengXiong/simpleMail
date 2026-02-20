import assert from 'node:assert/strict';
import { pool } from '../../db/pool.js';
import { computeThreadForMessage, listThreadMessages } from '../threading.js';

type QueryCall = {
  text: string;
  params: any[];
};

type QueryStep = {
  rows?: any[];
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

await test('prefers canonical Gmail logical message match before reply/reference heuristics', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.match(call.text, /UPDATE messages SET normalized_subject = \$2 WHERE id = \$1/);
          assert.deepEqual(call.params, ['msg-1', 'launch plan']);
        },
      },
      {
        rows: [{ thread_id: 'thread-canonical' }],
        check: (call) => {
          assert.match(call.text, /gmail_message_id = \$3/);
          assert.deepEqual(call.params, ['conn-1', 'msg-1', 'gmail-1']);
        },
      },
      {
        check: (call) => {
          assert.equal(call.text.trim(), 'UPDATE messages SET thread_id = $2 WHERE id = $1');
          assert.deepEqual(call.params, ['msg-1', 'thread-canonical']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /incoming_connector_id = \$1/);
          assert.match(call.text, /gmail_message_id = \$4/);
          assert.match(call.text, /LOWER\(COALESCE\(message_id, ''\)\) = ANY\(\$5::text\[\]\)/);
          assert.match(call.text, /normalized_subject = \$6/);
          assert.deepEqual(call.params.slice(0, 4), ['conn-1', 'thread-canonical', 'msg-1', 'gmail-1']);
          assert.ok(Array.isArray(call.params[4]));
          assert.ok(call.params[4].includes('canonical@example.com'));
          assert.ok(call.params[4].includes('<canonical@example.com>'));
          assert.equal(call.params[5], 'launch plan');
        },
      },
    ],
    async () => {
      const threadId = await computeThreadForMessage({
        id: 'msg-1',
        incomingConnectorId: 'conn-1',
        userId: 'user-1',
        gmailMessageId: ' gmail-1 ',
        messageId: '<canonical@example.com>',
        subject: 'Re: Launch Plan',
      });
      assert.equal(threadId, 'thread-canonical');
    },
  );
});

await test('falls back to Message-ID logical dedupe when Gmail id has no match', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-2', 'status update']);
        },
      },
      {
        rows: [],
        check: (call) => {
          assert.match(call.text, /gmail_message_id = \$3/);
          assert.deepEqual(call.params, ['conn-1', 'msg-2', 'gmail-miss']);
        },
      },
      {
        rows: [{ thread_id: 'thread-by-message-id' }],
        check: (call) => {
          assert.match(call.text, /LOWER\(COALESCE\(message_id, ''\)\) = ANY\(\$3::text\[\]\)/);
          assert.deepEqual(call.params.slice(0, 2), ['conn-1', 'msg-2']);
          assert.ok(Array.isArray(call.params[2]));
          assert.ok(call.params[2].includes('mid@example.com'));
          assert.ok(call.params[2].includes('<mid@example.com>'));
        },
      },
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-2', 'thread-by-message-id']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /normalized_subject = \$6/);
          assert.deepEqual(call.params.slice(0, 4), ['conn-1', 'thread-by-message-id', 'msg-2', 'gmail-miss']);
          assert.ok(Array.isArray(call.params[4]));
          assert.ok(call.params[4].includes('mid@example.com'));
          assert.ok(call.params[4].includes('<mid@example.com>'));
          assert.equal(call.params[5], 'status update');
        },
      },
    ],
    async () => {
      const threadId = await computeThreadForMessage({
        id: 'msg-2',
        incomingConnectorId: 'conn-1',
        userId: 'user-1',
        gmailMessageId: 'gmail-miss',
        messageId: '<mid@example.com>',
        subject: 'Re: Status Update',
      });
      assert.equal(threadId, 'thread-by-message-id');
    },
  );
});

await test('uses In-Reply-To parent thread when canonical matching fails', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-3', 'prod issue']);
        },
      },
      {
        rows: [{ thread_id: 'thread-in-reply' }],
        check: (call) => {
          assert.match(call.text, /WHERE LOWER\(COALESCE\(m\.message_id, ''\)\) = ANY\(\$1::text\[\]\)/);
          assert.ok(Array.isArray(call.params[0]));
          assert.ok(call.params[0].includes('parent@example.com'));
          assert.ok(call.params[0].includes('<parent@example.com>'));
          assert.equal(call.params[1], 'user-1');
        },
      },
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-3', 'thread-in-reply']);
        },
      },
    ],
    async (calls) => {
      const threadId = await computeThreadForMessage({
        id: 'msg-3',
        incomingConnectorId: 'conn-1',
        userId: 'user-1',
        inReplyTo: '<parent@example.com>',
        subject: 'Re: Prod Issue',
      });
      assert.equal(threadId, 'thread-in-reply');
      assert.equal(calls.length, 3);
    },
  );
});

await test('prefers the most direct parent from References chain tail', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-4', 'incident timeline']);
        },
      },
      {
        rows: [],
        check: (call) => {
          assert.match(call.text, /WHERE LOWER\(COALESCE\(m\.message_id, ''\)\) = ANY\(\$1::text\[\]\)/);
          assert.ok(Array.isArray(call.params[0]));
          assert.ok(call.params[0].includes('root@example.com'));
          assert.ok(call.params[0].includes('<root@example.com>'));
          assert.equal(call.params[1], 'user-1');
        },
      },
      {
        rows: [
          { message_id: 'root@example.com', thread_id: 'thread-root', received_at: '2026-02-01T00:00:00.000Z' },
          { message_id: 'parent@example.com', thread_id: 'thread-parent', received_at: '2026-02-01T00:01:00.000Z' },
        ],
        check: (call) => {
          assert.match(call.text, /m\.thread_id IS NOT NULL/);
          assert.ok(Array.isArray(call.params[0]));
          assert.ok(call.params[0].includes('root@example.com'));
          assert.ok(call.params[0].includes('<root@example.com>'));
          assert.ok(call.params[0].includes('parent@example.com'));
          assert.ok(call.params[0].includes('<parent@example.com>'));
          assert.equal(call.params[1], 'user-1');
        },
      },
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-4', 'thread-parent']);
        },
      },
    ],
    async () => {
      const threadId = await computeThreadForMessage({
        id: 'msg-4',
        incomingConnectorId: 'conn-1',
        userId: 'user-1',
        inReplyTo: '<root@example.com>',
        referencesHeader: '<root@example.com> <parent@example.com>',
        subject: 'Re: Incident Timeline',
      });
      assert.equal(threadId, 'thread-parent');
    },
  );
});

await test('falls back to subject candidates with participant overlap when headers are missing', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-5', 'project alpha']);
        },
      },
      {
        rows: [
          { thread_id: 'thread-no-overlap', from_header: 'Charlie <charlie@example.com>', to_header: 'Dana <dana@example.com>' },
          { thread_id: 'thread-overlap', from_header: 'Bob <bob@example.com>', to_header: 'Alice <alice@example.com>' },
        ],
        check: (call) => {
          assert.match(call.text, /normalized_subject = \$2/);
          assert.match(call.text, /received_at BETWEEN \$3::timestamptz/);
          assert.deepEqual(call.params, ['conn-1', 'project alpha', '2026-02-10T10:00:00.000Z', 'msg-5']);
        },
      },
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-5', 'thread-overlap']);
        },
      },
    ],
    async () => {
      const threadId = await computeThreadForMessage({
        id: 'msg-5',
        incomingConnectorId: 'conn-1',
        userId: 'user-1',
        subject: 'Re: Project Alpha',
        fromHeader: 'Alice <alice@example.com>',
        toHeader: 'Bob <bob@example.com>',
        receivedAt: '2026-02-10T10:00:00.000Z',
      });
      assert.equal(threadId, 'thread-overlap');
    },
  );
});

await test('creates fresh thread id for generic/new subject without explicit thread headers', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-6', 'hello there']);
        },
      },
      {
        check: (call) => {
          assert.equal(call.params[0], 'msg-6');
          assert.match(String(call.params[1]), /^[0-9a-f-]{36}$/i);
        },
      },
    ],
    async (calls) => {
      const threadId = await computeThreadForMessage({
        id: 'msg-6',
        incomingConnectorId: 'conn-1',
        userId: 'user-1',
        subject: 'Hello there',
      });
      assert.match(String(threadId), /^[0-9a-f-]{36}$/i);
      assert.equal(calls.length, 2);
      assert.equal(calls[1]?.params[1], threadId);
    },
  );
});

await test('reuses subject-based thread even without overlap when one side has unknown participants', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-7', 'quarterly digest']);
        },
      },
      {
        rows: [{ thread_id: 'thread-empty-participants', from_header: 'Sender <sender@example.com>', to_header: 'Team <team@example.com>' }],
      },
      {
        check: (call) => {
          assert.deepEqual(call.params, ['msg-7', 'thread-empty-participants']);
        },
      },
    ],
    async () => {
      const threadId = await computeThreadForMessage({
        id: 'msg-7',
        incomingConnectorId: 'conn-1',
        userId: 'user-1',
        subject: 'Re: Quarterly Digest',
        fromHeader: null,
        toHeader: null,
      });
      assert.equal(threadId, 'thread-empty-participants');
    },
  );
});

await test('listThreadMessages applies connector scoping when connectorId is provided', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'm1' }],
        check: (call) => {
          assert.match(call.text, /AND m\.incoming_connector_id = \$3/);
          assert.deepEqual(call.params, ['thread-1', 'user-1', 'conn-1']);
        },
      },
    ],
    async () => {
      const rows = await listThreadMessages('user-1', 'thread-1', 'conn-1');
      assert.deepEqual(rows, [{ id: 'm1' }]);
    },
  );
});

await test('listThreadMessages omits connector predicate when connectorId is absent', async () => {
  await withMockedQueries(
    [
      {
        rows: [{ id: 'm2' }],
        check: (call) => {
          assert.doesNotMatch(call.text, /AND m\.incoming_connector_id = \$3/);
          assert.deepEqual(call.params, ['thread-2', 'user-1']);
        },
      },
    ],
    async () => {
      const rows = await listThreadMessages('user-1', 'thread-2');
      assert.deepEqual(rows, [{ id: 'm2' }]);
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
