import assert from 'node:assert/strict';
import {
  normalizeSubject,
  subjectGenericKey,
  extractEmails,
  intersects,
  normalizeMessageId,
  messageIdVariants,
  isSubjectTooGeneric,
  GENERIC_SUBJECTS,
} from '../threadingUtils.js';

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


test('strips single Re: prefix', () => {
  assert.equal(normalizeSubject('Re: Meeting'), 'meeting');
});

test('strips multiple Re: prefixes', () => {
  assert.equal(normalizeSubject('Re: Re: Re: Meeting'), 'meeting');
});

test('strips mixed Re/Fwd prefixes', () => {
  assert.equal(normalizeSubject('Fwd: Re: Fwd: Meeting notes'), 'meeting notes');
});

test('strips Fw: prefix', () => {
  assert.equal(normalizeSubject('Fw: FW: hello world'), 'hello world');
});

test('handles empty subject', () => {
  assert.equal(normalizeSubject(''), '');
  assert.equal(normalizeSubject(undefined), '');
});

test('trims and lowercases', () => {
  assert.equal(normalizeSubject('  Meeting NOTES  '), 'meeting notes');
});

test('strips leading/trailing non-alphanumeric', () => {
  assert.equal(normalizeSubject('** Important! **'), 'important');
});

test('collapses whitespace', () => {
  assert.equal(normalizeSubject('many   spaces   here'), 'many spaces here');
});

test('handles Re: with spaces before colon', () => {
  assert.equal(normalizeSubject('Re : Re : test'), 'test');
});


test('strips punctuation and normalizes', () => {
  assert.equal(subjectGenericKey('Hello!'), 'hello');
});

test('collapses whitespace in generic key', () => {
  assert.equal(subjectGenericKey('  hi  there  '), 'hi there');
});


test('extracts single email', () => {
  assert.deepEqual(extractEmails('alice@example.com'), ['alice@example.com']);
});

test('extracts display name + angle bracket email', () => {
  assert.deepEqual(extractEmails('Alice <alice@example.com>'), ['alice@example.com']);
});

test('extracts multiple emails', () => {
  const result = extractEmails('Alice <alice@example.com>, Bob <bob@test.org>');
  assert.deepEqual(result.sort(), ['alice@example.com', 'bob@test.org']);
});

test('deduplicates case-insensitively', () => {
  assert.deepEqual(extractEmails('Alice@EXAMPLE.com, alice@example.com'), ['alice@example.com']);
});

test('handles null/undefined', () => {
  assert.deepEqual(extractEmails(null), []);
  assert.deepEqual(extractEmails(undefined), []);
  assert.deepEqual(extractEmails(''), []);
});


test('detects intersection', () => {
  assert.equal(intersects(['a', 'b'], ['b', 'c']), true);
});

test('no intersection', () => {
  assert.equal(intersects(['a', 'b'], ['c', 'd']), false);
});

test('empty arrays', () => {
  assert.equal(intersects([], ['a']), false);
  assert.equal(intersects(['a'], []), false);
});


test('strips angle brackets and lowercases', () => {
  assert.equal(normalizeMessageId('<ABC@example.com>'), 'abc@example.com');
});

test('handles bare message ID', () => {
  assert.equal(normalizeMessageId('abc@example.com'), 'abc@example.com');
});

test('handles double angle brackets', () => {
  assert.equal(normalizeMessageId('<<abc@example.com>>'), 'abc@example.com');
});

test('returns null for empty/null', () => {
  assert.equal(normalizeMessageId(null), null);
  assert.equal(normalizeMessageId(''), null);
  assert.equal(normalizeMessageId('   '), null);
});


test('returns both bare and angle-bracketed forms', () => {
  assert.deepEqual(messageIdVariants('<ABC@example.com>'), [
    'abc@example.com',
    '<abc@example.com>',
  ]);
});

test('returns empty for null', () => {
  assert.deepEqual(messageIdVariants(null), []);
  assert.deepEqual(messageIdVariants(''), []);
});


test('detects generic subjects', () => {
  assert.equal(isSubjectTooGeneric('hi', false, false), true);
  assert.equal(isSubjectTooGeneric('test', false, false), true);
  assert.equal(isSubjectTooGeneric('invoice', false, false), true);
});

test('short subjects are generic', () => {
  assert.equal(isSubjectTooGeneric('ab', false, false), true);
  assert.equal(isSubjectTooGeneric('ok', false, false), true);
});

test('non-generic subject without headers/prefix is still generic', () => {
  assert.equal(isSubjectTooGeneric('project update notes', false, false), true);
});

test('non-generic subject with Re: prefix is NOT generic', () => {
  assert.equal(isSubjectTooGeneric('project update notes', false, true), false);
});

test('non-generic subject with thread headers is NOT generic', () => {
  assert.equal(isSubjectTooGeneric('project update notes', true, false), false);
});

test('empty subject is generic', () => {
  assert.equal(isSubjectTooGeneric('', false, false), true);
});


test('contains common generic subjects', () => {
  assert.equal(GENERIC_SUBJECTS.has('hi'), true);
  assert.equal(GENERIC_SUBJECTS.has('invoice'), true);
  assert.equal(GENERIC_SUBJECTS.has('fyi'), true);
  assert.equal(GENERIC_SUBJECTS.has('notification'), true);
});

test('does not contain non-generic subjects', () => {
  assert.equal(GENERIC_SUBJECTS.has('project plan'), false);
  assert.equal(GENERIC_SUBJECTS.has('quarterly review'), false);
});


console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
