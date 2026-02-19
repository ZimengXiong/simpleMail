import assert from 'node:assert/strict';
import {
  buildReplyReferencesHeader,
  normalizeMessageIdHeader,
  orderThreadMessages,
} from '../../client/src/services/threading.ts';

type TestMessage = {
  id: string;
  messageId: string;
  receivedAt: string;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
};

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${error}`);
  }
};

const ts = (value: string) => new Date(value).toISOString();

const msg = (
  id: string,
  messageId: string,
  receivedAt: string,
  options: { inReplyTo?: string; referencesHeader?: string } = {},
): TestMessage => ({
  id,
  messageId,
  receivedAt: ts(receivedAt),
  inReplyTo: options.inReplyTo ?? null,
  referencesHeader: options.referencesHeader ?? null,
});

test('orders a linear conversation by parent-child chain', () => {
  const messages: TestMessage[] = [
    msg('m3', '<c@example.com>', '2026-01-01T10:02:00Z', {
      inReplyTo: '<b@example.com>',
      referencesHeader: '<a@example.com> <b@example.com>',
    }),
    msg('m1', '<a@example.com>', '2026-01-01T10:00:00Z'),
    msg('m2', '<b@example.com>', '2026-01-01T10:01:00Z', {
      inReplyTo: '<a@example.com>',
      referencesHeader: '<a@example.com>',
    }),
  ];

  const ordered = orderThreadMessages(messages);
  assert.deepEqual(ordered.map((entry) => entry.message.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(ordered.map((entry) => entry.depth), [0, 1, 2]);
  assert.equal(ordered[1].parentId, 'm1');
  assert.equal(ordered[2].parentId, 'm2');
});

test('prefers the most direct parent from References tail', () => {
  const messages: TestMessage[] = [
    msg('root', '<root@example.com>', '2026-01-01T08:00:00Z'),
    msg('branch-a', '<a@example.com>', '2026-01-01T08:10:00Z', {
      inReplyTo: '<root@example.com>',
      referencesHeader: '<root@example.com>',
    }),
    msg('branch-b', '<b@example.com>', '2026-01-01T08:20:00Z', {
      inReplyTo: '<root@example.com>',
      referencesHeader: '<root@example.com>',
    }),
    msg('child', '<child@example.com>', '2026-01-01T08:30:00Z', {
      inReplyTo: '<b@example.com>',
      referencesHeader: '<root@example.com> <a@example.com> <b@example.com>',
    }),
  ];

  const ordered = orderThreadMessages(messages);
  const child = ordered.find((entry) => entry.message.id === 'child');
  assert.ok(child);
  assert.equal(child?.parentId, 'branch-b');
  assert.equal(child?.depth, 2);
});

test('links replies to the newest matching logical message id', () => {
  const messages: TestMessage[] = [
    msg('old-copy', '<dup@example.com>', '2026-01-01T09:00:00Z'),
    msg('new-copy', '<DUP@example.com>', '2026-01-01T09:10:00Z'),
    msg('reply', '<reply@example.com>', '2026-01-01T09:20:00Z', {
      inReplyTo: 'dup@example.com',
    }),
  ];

  const ordered = orderThreadMessages(messages);
  const reply = ordered.find((entry) => entry.message.id === 'reply');
  assert.ok(reply);
  assert.equal(reply?.parentId, 'new-copy');
});

test('breaks malformed cycles instead of recursing forever', () => {
  const messages: TestMessage[] = [
    msg('a', '<a@example.com>', '2026-01-01T12:01:00Z', { inReplyTo: '<b@example.com>' }),
    msg('b', '<b@example.com>', '2026-01-01T12:00:00Z', { inReplyTo: '<a@example.com>' }),
  ];

  const ordered = orderThreadMessages(messages);
  assert.equal(ordered.length, 2);
  const parentIds = ordered.map((entry) => entry.parentId);
  assert.ok(parentIds.some((value) => value === null));
});

test('normalizes and deduplicates reply references header tokens', () => {
  const references = buildReplyReferencesHeader('<A@example.com> a@example.com <b@example.com>', 'B@EXAMPLE.com');
  assert.equal(references, '<a@example.com> <b@example.com>');
});

test('normalizes Message-ID header values', () => {
  assert.equal(normalizeMessageIdHeader('<AbC@example.com>'), '<abc@example.com>');
  assert.equal(normalizeMessageIdHeader('abc@example.com'), '<abc@example.com>');
  assert.equal(normalizeMessageIdHeader('   '), null);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
