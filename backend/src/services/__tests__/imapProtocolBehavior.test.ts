import assert from 'node:assert/strict';
import {
  isGmailHistoryTooOldError,
  resolveImapTlsModeForConnector,
  shouldResetMailboxForUidValidity,
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

test('uses explicit tls_mode when provided', () => {
  assert.equal(resolveImapTlsModeForConnector({ tls_mode: 'starttls' }, 993), 'starttls');
  assert.equal(resolveImapTlsModeForConnector({ tlsMode: 'none' }, 993), 'none');
});

test('supports sync/auth config tls mode overrides', () => {
  assert.equal(
    resolveImapTlsModeForConnector({ sync_settings: { imapTlsMode: 'none' } }, 993),
    'none',
  );
  assert.equal(
    resolveImapTlsModeForConnector({ auth_config: { tlsMode: 'starttls' } }, 993),
    'starttls',
  );
});

test('maps boolean tls fallback by port', () => {
  assert.equal(resolveImapTlsModeForConnector({ tls: true }, 143), 'starttls');
  assert.equal(resolveImapTlsModeForConnector({ tls: true }, 993), 'ssl');
  assert.equal(resolveImapTlsModeForConnector({ tls: false }, 993), 'none');
});

test('uses safe defaults without explicit config', () => {
  assert.equal(resolveImapTlsModeForConnector({}, 143), 'starttls');
  assert.equal(resolveImapTlsModeForConnector({}, 993), 'ssl');
});

test('recognizes stale gmail history errors', () => {
  assert.equal(isGmailHistoryTooOldError('Gmail API 404 Not Found: startHistoryId is too old'), true);
  assert.equal(isGmailHistoryTooOldError(new Error('invalid startHistoryId value')), true);
  assert.equal(isGmailHistoryTooOldError('Gmail API 500 Internal Server Error'), false);
});

test('resets mailbox state only on explicit uidvalidity mismatch', () => {
  assert.equal(shouldResetMailboxForUidValidity('123', '124'), true);
  assert.equal(shouldResetMailboxForUidValidity('123', '123'), false);
  assert.equal(shouldResetMailboxForUidValidity(null, '123'), false);
  assert.equal(shouldResetMailboxForUidValidity('123', null), false);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
