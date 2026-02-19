/**
 * Unit tests for sync priority active-mailbox logic.
 * Run with: npx tsx src/services/__tests__/syncPriority.test.ts
 */
import assert from 'node:assert/strict';
import { markActiveMailbox, resolveSyncQueuePriority } from '../syncPriority.js';

let passed = 0;
let failed = 0;
let testCounter = 0;

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

const withFakeNow = (startMs: number, fn: (advanceMs: (deltaMs: number) => void) => void) => {
  const originalNow = Date.now;
  let nowMs = startMs;
  Date.now = () => nowMs;
  try {
    fn((deltaMs) => {
      nowMs += deltaMs;
    });
  } finally {
    Date.now = originalNow;
  }
};

const nextUserId = () => {
  testCounter += 1;
  return `user-${testCounter}`;
};

test('returns high priority for active connector + mailbox', () => {
  const userId = nextUserId();
  markActiveMailbox(userId, 'connector-a', 'inbox');
  assert.equal(resolveSyncQueuePriority(userId, 'connector-a', 'INBOX'), 'high');
});

test('returns normal priority for different mailbox', () => {
  const userId = nextUserId();
  markActiveMailbox(userId, 'connector-a', 'INBOX');
  assert.equal(resolveSyncQueuePriority(userId, 'connector-a', 'Archive'), 'normal');
});

test('returns normal priority for different connector', () => {
  const userId = nextUserId();
  markActiveMailbox(userId, 'connector-a', 'INBOX');
  assert.equal(resolveSyncQueuePriority(userId, 'connector-b', 'INBOX'), 'normal');
});

test('active mailbox state expires after TTL', () => {
  withFakeNow(1_000_000, (advanceMs) => {
    const userId = nextUserId();
    markActiveMailbox(userId, 'connector-a', 'INBOX');
    assert.equal(resolveSyncQueuePriority(userId, 'connector-a', 'INBOX'), 'high');
    advanceMs(91_000);
    assert.equal(resolveSyncQueuePriority(userId, 'connector-a', 'INBOX'), 'normal');
  });
});

test('new mark replaces prior active mailbox for same user', () => {
  const userId = nextUserId();
  markActiveMailbox(userId, 'connector-a', 'INBOX');
  markActiveMailbox(userId, 'connector-a', 'SENT');
  assert.equal(resolveSyncQueuePriority(userId, 'connector-a', 'INBOX'), 'normal');
  assert.equal(resolveSyncQueuePriority(userId, 'connector-a', 'SENT'), 'high');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
