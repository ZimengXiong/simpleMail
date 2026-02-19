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

test('prefers references chain over in-reply-to when both are present', () => {
  const messages: TestMessage[] = [
    msg('root', '<root@example.com>', '2026-01-01T10:00:00Z'),
    msg('middle', '<middle@example.com>', '2026-01-01T10:10:00Z', {
      inReplyTo: '<root@example.com>',
      referencesHeader: '<root@example.com>',
    }),
    msg('child', '<child@example.com>', '2026-01-01T10:20:00Z', {
      inReplyTo: '<root@example.com>',
      referencesHeader: '<root@example.com> <middle@example.com>',
    }),
  ];

  const ordered = orderThreadMessages(messages);
  const child = ordered.find((entry) => entry.message.id === 'child');
  assert.ok(child);
  assert.equal(child?.parentId, 'middle');
  assert.equal(child?.depth, 2);
});

test('ignores self-references and keeps message as root', () => {
  const messages: TestMessage[] = [
    msg('self', '<self@example.com>', '2026-01-01T11:00:00Z', {
      inReplyTo: '<self@example.com>',
      referencesHeader: '<self@example.com>',
    }),
  ];

  const ordered = orderThreadMessages(messages);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].parentId, null);
  assert.equal(ordered[0].depth, 0);
});

test('keeps unresolved parent references as independent roots', () => {
  const messages: TestMessage[] = [
    msg('known', '<known@example.com>', '2026-01-01T09:00:00Z'),
    msg('orphan', '<orphan@example.com>', '2026-01-01T09:10:00Z', {
      inReplyTo: '<missing@example.com>',
      referencesHeader: '<missing@example.com>',
    }),
  ];

  const ordered = orderThreadMessages(messages);
  const orphan = ordered.find((entry) => entry.message.id === 'orphan');
  assert.ok(orphan);
  assert.equal(orphan?.parentId, null);
  assert.equal(orphan?.depth, 0);
});

test('orders roots by timestamp and falls back to input order for equal timestamps', () => {
  const messages: TestMessage[] = [
    msg('second', '<second@example.com>', '2026-01-01T08:00:00Z'),
    msg('first', '<first@example.com>', '2026-01-01T08:00:00Z'),
    msg('third', '<third@example.com>', '2026-01-01T08:01:00Z'),
  ];

  const ordered = orderThreadMessages(messages);
  assert.deepEqual(ordered.map((entry) => entry.message.id), ['second', 'first', 'third']);
  assert.deepEqual(ordered.map((entry) => entry.depth), [0, 0, 0]);
});

test('deduplicates references and appends current message id exactly once', () => {
  const references = buildReplyReferencesHeader(
    '<A@example.com> a@example.com <b@example.com> <a@example.com>',
    '<B@example.com>',
  );
  assert.equal(references, '<a@example.com> <b@example.com>');
});

test('normalizes first message-id token from malformed headers', () => {
  assert.equal(normalizeMessageIdHeader('  <<AbC@example.com>>  extra-token'), '<abc@example.com>');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
