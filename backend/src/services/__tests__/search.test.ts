/**
 * Unit tests for message search query parsing.
 * Run with: npx tsx src/services/__tests__/search.test.ts
 */
import assert from 'node:assert/strict';
import { parseMessageSearchQuery } from '../search.js';

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

const withFakeNow = (startMs: number, fn: () => void) => {
  const originalNow = Date.now;
  Date.now = () => startMs;
  try {
    fn();
  } finally {
    Date.now = originalNow;
  }
};

test('parses free terms, quoted terms, and negated free terms', () => {
  const parsed = parseMessageSearchQuery('"quarterly report" -draft roadmap');
  assert.deepEqual(parsed.freeTerms, ['quarterly report', 'roadmap']);
  assert.deepEqual(parsed.freeNegatedTerms, ['draft']);
});

test('parses supported field operators and flags', () => {
  const parsed = parseMessageSearchQuery(
    'from:alice@example.com -to:bob@example.com subject:"Q1 Plan" label:Important -label:Spam has:attachment is:unread',
  );
  assert.deepEqual(parsed.fromTerms, ['alice@example.com']);
  assert.deepEqual(parsed.toNegatedTerms, ['bob@example.com']);
  assert.deepEqual(parsed.subjectTerms, ['Q1 Plan']);
  assert.deepEqual(parsed.labelIncludes, ['important']);
  assert.deepEqual(parsed.labelExcludes, ['spam']);
  assert.equal(parsed.hasAttachment, true);
  assert.equal(parsed.isUnread, true);
  assert.equal(parsed.isRead, false);
});

test('parses relative and absolute dates, including negated date filters', () => {
  withFakeNow(Date.UTC(2026, 1, 19, 20, 0, 0, 0), () => {
    const parsed = parseMessageSearchQuery('after:7d before:2026-02-01 -before:2026-01-01');
    assert.equal(parsed.dateAfter, '2026-02-12T20:00:00.000Z');
    assert.equal(parsed.dateBefore, '2026-02-01T00:00:00.000Z');
    assert.deepEqual(parsed.dateBeforeExcludes, ['2026-01-01T00:00:00.000Z']);
  });
});

test('negated is:unread implies read filter', () => {
  const parsed = parseMessageSearchQuery('-is:unread');
  assert.equal(parsed.isRead, true);
  assert.equal(parsed.isUnread, false);
});

test('unknown operators are treated as free terms', () => {
  const parsed = parseMessageSearchQuery('foo:bar bar:baz');
  assert.deepEqual(parsed.freeTerms, ['foo:bar', 'bar:baz']);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
