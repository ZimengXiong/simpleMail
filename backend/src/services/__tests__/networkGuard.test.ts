/**
 * Unit tests for outbound network target validation.
 * Run with: npx tsx src/services/__tests__/networkGuard.test.ts
 */
import assert from 'node:assert/strict';
import { env } from '../../config/env.js';
import { assertSafeOutboundHost, assertSafePushEndpoint } from '../networkGuard.js';

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

const assertBadRequest = async (action: () => Promise<unknown>, messagePattern: RegExp) => {
  await assert.rejects(action, (error: any) => {
    assert.equal(error?.statusCode, 400);
    assert.match(String(error?.message ?? error), messagePattern);
    return true;
  });
};

const originalAllowPrivate = env.allowPrivateNetworkTargets;
const originalNodeEnv = env.nodeEnv;

env.allowPrivateNetworkTargets = false;
env.nodeEnv = 'production';

try {
  await test('rejects empty outbound host values', async () => {
    await assertBadRequest(() => assertSafeOutboundHost(''), /host is required/i);
  });

  await test('rejects blocked localhost hostnames', async () => {
    await assertBadRequest(() => assertSafeOutboundHost('localhost'), /blocked hostname/i);
  });

  await test('rejects private and reserved IPv4 targets', async () => {
    await assertBadRequest(() => assertSafeOutboundHost('192.168.1.25'), /private or reserved ip/i);
  });

  await test('rejects private and reserved IPv6 targets', async () => {
    await assertBadRequest(() => assertSafeOutboundHost('fd00::1'), /private or reserved ip/i);
  });

  await test('rejects link-local IPv6 targets', async () => {
    await assertBadRequest(() => assertSafeOutboundHost('fe80::1'), /private or reserved ip/i);
  });

  await test('rejects IPv4-mapped loopback IPv6 targets', async () => {
    await assertBadRequest(() => assertSafeOutboundHost('::ffff:127.0.0.1'), /private or reserved ip/i);
  });

  await test('accepts public direct IPv4 targets', async () => {
    await assert.doesNotReject(() => assertSafeOutboundHost('8.8.8.8'));
  });

  await test('allows blocked/private hosts when private-target override is enabled', async () => {
    env.allowPrivateNetworkTargets = true;
    await assert.doesNotReject(() => assertSafeOutboundHost('localhost'));
    await assert.doesNotReject(() => assertSafeOutboundHost('10.0.0.15'));
    env.allowPrivateNetworkTargets = false;
  });

  await test('rejects invalid or non-https push endpoints', async () => {
    await assertBadRequest(() => assertSafePushEndpoint('not-a-url'), /push endpoint is invalid/i);
    await assertBadRequest(() => assertSafePushEndpoint('http://example.com/push'), /must use https/i);
  });

  await test('rejects push endpoints with private hosts', async () => {
    await assertBadRequest(() => assertSafePushEndpoint('https://127.0.0.1/push'), /private or reserved ip/i);
  });
} finally {
  env.allowPrivateNetworkTargets = originalAllowPrivate;
  env.nodeEnv = originalNodeEnv;
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
