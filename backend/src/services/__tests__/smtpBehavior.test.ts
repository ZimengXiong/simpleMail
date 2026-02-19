import assert from 'node:assert/strict';
import { isRecoverableSmtpError, parseEnvelopeRecipients } from '../smtp.js';

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

test('parses and de-duplicates envelope recipients from mixed address formats', () => {
  const recipients = parseEnvelopeRecipients(
    'Alice <alice@example.com>; Bob <bob@example.com>',
    ['carol@example.com', 'ALICE@example.com', 'Dave <dave@example.com>'],
  );
  assert.deepEqual(recipients, [
    'alice@example.com',
    'bob@example.com',
    'carol@example.com',
    'dave@example.com',
  ]);
});

test('returns empty recipient list when no addresses are present', () => {
  assert.deepEqual(parseEnvelopeRecipients(undefined, []), []);
  assert.deepEqual(parseEnvelopeRecipients('', ['   ']), []);
});

test('marks transient SMTP status codes as recoverable', () => {
  assert.equal(isRecoverableSmtpError({ responseCode: 421 }), true);
  assert.equal(isRecoverableSmtpError({ responseCode: 451 }), true);
});

test('marks network faults as recoverable', () => {
  assert.equal(isRecoverableSmtpError({ code: 'ECONNRESET' }), true);
  assert.equal(isRecoverableSmtpError({ code: 'ETIMEDOUT' }), true);
});

test('does not retry permanent SMTP failures', () => {
  assert.equal(isRecoverableSmtpError({ responseCode: 550 }), false);
  assert.equal(isRecoverableSmtpError(new Error('mailbox unavailable')), false);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
