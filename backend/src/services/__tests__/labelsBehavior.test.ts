import assert from 'node:assert/strict';
import { pool } from '../../db/pool.js';
import {
  addLabelsToMessage,
  addLabelsToMessageByKey,
  archiveLabel,
  createUserLabel,
  getLabel,
  getLabelByKey,
  listLabels,
  listMessageLabels,
  removeLabelsFromMessage,
  removeLabelsFromMessageByKey,
  syncSystemLabelsForMessage,
  updateLabelName,
} from '../labels.js';

type QueryCall = {
  text: string;
  params: any[];
};

type QueryStep = {
  rows?: any[];
  check?: (call: QueryCall) => void;
};

const withMockedQueries = async (steps: QueryStep[], fn: () => Promise<void> | void) => {
  const originalQuery = pool.query.bind(pool);
  let index = 0;

  (pool as any).query = async (text: string, params: any[] = []) => {
    const call = { text: String(text), params: Array.isArray(params) ? params : [] };
    const step = steps[index];
    if (!step) {
      throw new Error(`Unexpected query #${index + 1}: ${call.text}`);
    }
    index += 1;
    step.check?.(call);
    return { rows: step.rows ?? [] };
  };

  try {
    await fn();
    assert.equal(index, steps.length, `Expected ${steps.length} query calls, got ${index}`);
  } finally {
    (pool as any).query = originalQuery;
  }
};

const systemLabelUpsertSteps = (userId: string): QueryStep[] => {
  const keys = ['all', 'trash', 'spam', 'snoozed', 'starred'];
  return keys.map((key) => ({
    check: (call) => {
      assert.match(call.text, /INSERT INTO labels/);
      assert.equal(call.params[0], userId);
      assert.equal(call.params[1], key);
    },
  }));
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

await test('lists labels after ensuring system labels exist', async () => {
  await withMockedQueries(
    [
      ...systemLabelUpsertSteps('user-1'),
      {
        rows: [{ id: 'lbl-1', key: 'work', name: 'Work', isSystem: false }],
        check: (call) => {
          assert.match(call.text, /SELECT id, key, name/);
          assert.match(call.text, /is_archived = FALSE/);
          assert.deepEqual(call.params, ['user-1']);
        },
      },
    ],
    async () => {
      const labels = await listLabels('user-1');
      assert.deepEqual(labels, [{ id: 'lbl-1', key: 'work', name: 'Work', isSystem: false }]);
    },
  );
});

await test('creates user labels with sanitized key and rejects invalid keys', async () => {
  await withMockedQueries(
    [
      ...systemLabelUpsertSteps('user-1'),
      {
        rows: [{ id: 'lbl-created' }],
        check: (call) => {
          assert.match(call.text, /INSERT INTO labels/);
          assert.equal(call.params[0], 'user-1');
          assert.equal(call.params[2], 'Project Alpha');
          assert.match(String(call.params[1]), /^project[-_]alpha$/);
        },
      },
    ],
    async () => {
      const created = await createUserLabel({ userId: 'user-1', name: 'Project Alpha', key: ' Project_Alpha! ' });
      assert.deepEqual(created, { id: 'lbl-created' });
    },
  );

  await withMockedQueries(
    [
      ...systemLabelUpsertSteps('user-1'),
    ],
    async () => {
      await assert.rejects(
        createUserLabel({ userId: 'user-1', name: 'Invalid', key: '!!!' }),
        /invalid label key/,
      );
    },
  );
});

await test('fetches labels by id and key with system-label bootstrap', async () => {
  await withMockedQueries(
    [
      ...systemLabelUpsertSteps('user-1'),
      {
        rows: [{ id: 'lbl-a', key: 'all', name: 'All Mail', isSystem: true }],
        check: (call) => {
          assert.match(call.text, /AND id = \$2/);
          assert.deepEqual(call.params, ['user-1', 'lbl-a']);
        },
      },
      ...systemLabelUpsertSteps('user-1'),
      {
        rows: [{ id: 'lbl-b', key: 'work', name: 'Work', isSystem: false }],
        check: (call) => {
          assert.match(call.text, /AND key = \$2/);
          assert.deepEqual(call.params, ['user-1', 'work']);
        },
      },
    ],
    async () => {
      assert.deepEqual(await getLabel('user-1', 'lbl-a'), { id: 'lbl-a', key: 'all', name: 'All Mail', isSystem: true });
      assert.deepEqual(await getLabelByKey('user-1', 'work'), { id: 'lbl-b', key: 'work', name: 'Work', isSystem: false });
    },
  );
});

await test('updates, archives, and lists labels for a message', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.match(call.text, /UPDATE labels/);
          assert.deepEqual(call.params, ['lbl-1', 'user-1', 'Renamed']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /SET is_archived = TRUE/);
          assert.deepEqual(call.params, ['lbl-1', 'user-1']);
        },
      },
      {
        rows: [{ id: 'lbl-2', key: 'work', name: 'Work', isSystem: false }],
        check: (call) => {
          assert.match(call.text, /FROM message_labels ml/);
          assert.deepEqual(call.params, ['msg-1', 'user-1']);
        },
      },
    ],
    async () => {
      await updateLabelName('user-1', 'lbl-1', 'Renamed');
      await archiveLabel('user-1', 'lbl-1');
      const labels = await listMessageLabels('user-1', 'msg-1');
      assert.deepEqual(labels, [{ id: 'lbl-2', key: 'work', name: 'Work', isSystem: false }]);
    },
  );
});

await test('adds/removes labels by id/key and no-ops empty sets', async () => {
  await withMockedQueries(
    [
      {
        check: (call) => {
          assert.match(call.text, /INSERT INTO message_labels/);
          assert.match(call.text, /l\.id IN \(\$3, \$4\)/);
          assert.deepEqual(call.params, ['msg-1', 'user-1', 'lbl-1', 'lbl-2']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /l\.key = ANY\(ARRAY\[\$3, \$4\]::text\[\]\)/);
          assert.deepEqual(call.params, ['msg-1', 'user-1', 'work', 'todo']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /DELETE FROM message_labels ml/);
          assert.deepEqual(call.params, ['msg-1', ['lbl-1'], 'user-1']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /l\.key = ANY\(\$2::text\[\]\)/);
          assert.deepEqual(call.params, ['msg-1', ['work'], 'user-1']);
        },
      },
    ],
    async () => {
      await addLabelsToMessage('user-1', 'msg-1', ['lbl-1', 'lbl-2']);
      await addLabelsToMessageByKey('user-1', 'msg-1', ['work', 'todo']);
      await removeLabelsFromMessage('user-1', 'msg-1', ['lbl-1']);
      await removeLabelsFromMessageByKey('user-1', 'msg-1', ['work']);
    },
  );

  await withMockedQueries([], async () => {
    await addLabelsToMessage('user-1', 'msg-1', []);
    await addLabelsToMessageByKey('user-1', 'msg-1', []);
    await removeLabelsFromMessage('user-1', 'msg-1', []);
    await removeLabelsFromMessageByKey('user-1', 'msg-1', []);
  });
});

await test('syncs system labels by removing stale and adding missing keys', async () => {
  await withMockedQueries(
    [
      ...systemLabelUpsertSteps('user-1'),
      {
        rows: [{ key: 'all' }, { key: 'spam' }, { key: 'trash' }],
        check: (call) => {
          assert.match(call.text, /SELECT l\.key/);
          assert.deepEqual(call.params, ['msg-2', 'user-1']);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /DELETE FROM message_labels ml/);
          assert.deepEqual(call.params, ['msg-2', 'user-1', ['spam', 'trash']]);
        },
      },
      {
        check: (call) => {
          assert.match(call.text, /INSERT INTO message_labels/);
          assert.deepEqual(call.params, ['msg-2', 'user-1', 'starred']);
        },
      },
    ],
    async () => {
      await syncSystemLabelsForMessage('user-1', 'msg-2', 'INBOX', true);
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
