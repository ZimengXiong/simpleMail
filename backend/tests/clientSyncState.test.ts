import assert from 'node:assert/strict';
import {
  isSyncStateActive,
  countActiveSyncStates,
  hasActiveSyncStates,
} from '../../client/src/services/syncState.ts';

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

const now = Date.parse('2026-02-19T20:00:00.000Z');

test('treats syncing state as active regardless of start timestamp', () => {
  assert.equal(isSyncStateActive({ status: 'syncing', syncStartedAt: null } as any, now), true);
});

test('treats queued state as active within stale window', () => {
  assert.equal(
    isSyncStateActive({ status: 'queued', syncStartedAt: '2026-02-19T19:58:30.000Z' } as any, now),
    true,
  );
});

test('treats cancel_requested as active within stale window', () => {
  assert.equal(
    isSyncStateActive({ status: 'cancel_requested', syncStartedAt: '2026-02-19T19:59:59.000Z' } as any, now),
    true,
  );
});

test('marks queued/cancel_requested as inactive when stale or malformed', () => {
  assert.equal(
    isSyncStateActive({ status: 'queued', syncStartedAt: '2026-02-19T19:55:59.000Z' } as any, now),
    false,
  );
  assert.equal(
    isSyncStateActive({ status: 'queued', syncStartedAt: 'not-a-date' } as any, now),
    false,
  );
});

test('rejects future syncStartedAt timestamps', () => {
  assert.equal(
    isSyncStateActive({ status: 'queued', syncStartedAt: '2026-02-19T20:01:00.000Z' } as any, now),
    false,
  );
});

test('treats null or unsupported states as inactive', () => {
  assert.equal(isSyncStateActive(null as any, now), false);
  assert.equal(isSyncStateActive(undefined as any, now), false);
  assert.equal(isSyncStateActive({ status: 'idle', syncStartedAt: '2026-02-19T19:59:00.000Z' } as any, now), false);
  assert.equal(isSyncStateActive({ status: 'error', syncStartedAt: '2026-02-19T19:59:00.000Z' } as any, now), false);
});

test('queued state is active exactly at stale boundary and inactive just beyond', () => {
  assert.equal(
    isSyncStateActive({ status: 'queued', syncStartedAt: '2026-02-19T19:58:00.000Z' } as any, now),
    true,
  );
  assert.equal(
    isSyncStateActive({ status: 'queued', syncStartedAt: '2026-02-19T19:57:59.999Z' } as any, now),
    false,
  );
});

test('counts active states with the same internal now snapshot', () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const count = countActiveSyncStates([
      { status: 'syncing', syncStartedAt: null } as any,
      { status: 'queued', syncStartedAt: '2026-02-19T19:58:00.000Z' } as any,
      { status: 'queued', syncStartedAt: '2026-02-19T19:40:00.000Z' } as any,
      { status: 'idle', syncStartedAt: '2026-02-19T19:59:30.000Z' } as any,
    ]);
    assert.equal(count, 2);
    assert.equal(hasActiveSyncStates([{ status: 'idle', syncStartedAt: null } as any]), false);
    assert.equal(hasActiveSyncStates([{ status: 'syncing', syncStartedAt: null } as any]), true);
    assert.equal(countActiveSyncStates([]), 0);
    assert.equal(countActiveSyncStates(undefined as any), 0);
  } finally {
    Date.now = originalNow;
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
