import assert from 'node:assert/strict';
import {
  getGmailMailboxPathAliases,
  normalizeGmailMailboxPath,
} from '../imap.js';

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

test('normalizes Google Mail system folder aliases', () => {
  assert.equal(normalizeGmailMailboxPath('[Google Mail]/Sent Mail'), 'SENT');
  assert.equal(normalizeGmailMailboxPath('[google mail]/all mail'), 'ALL');
  assert.equal(normalizeGmailMailboxPath('[Gmail]/Junk'), 'SPAM');
});

test('preserves custom Gmail label IDs', () => {
  assert.equal(normalizeGmailMailboxPath('Label_1234567890'), 'Label_1234567890');
  assert.equal(normalizeGmailMailboxPath('My Custom Label'), 'My Custom Label');
});

test('includes canonical and server aliases for known system folders', () => {
  const aliases = getGmailMailboxPathAliases('SENT');
  assert(aliases.includes('SENT'));
  assert(aliases.includes('[GMAIL]/SENT MAIL'));
});

test('provides case-insensitive matching aliases for custom labels', () => {
  const aliases = getGmailMailboxPathAliases('Label_abc');
  assert(aliases.includes('Label_abc'));
  assert(aliases.includes('LABEL_ABC'));
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
