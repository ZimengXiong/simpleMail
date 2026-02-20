import assert from 'node:assert/strict';
import { env } from '../../config/env.js';
import { getAttachmentScanDecision } from '../scanPolicy.js';

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

const original = {
  enabled: env.scan.enabled,
  maxAttachmentBytesForScan: env.scan.maxAttachmentBytesForScan,
  scanOnIngest: env.scan.scanOnIngest,
};

try {
  test('returns disabled decision when scanner is disabled', () => {
    env.scan.enabled = false;
    env.scan.maxAttachmentBytesForScan = 1024;
    env.scan.scanOnIngest = true;

    const result = getAttachmentScanDecision(512);
    assert.deepEqual(result, {
      disposition: 'skip',
      status: 'disabled',
      verdictHint: 'scanner-disabled',
    });
  });

  test('skips scanning when attachment size exceeds configured maximum', () => {
    env.scan.enabled = true;
    env.scan.maxAttachmentBytesForScan = 100;
    env.scan.scanOnIngest = true;

    const result = getAttachmentScanDecision(101);
    assert.deepEqual(result, {
      disposition: 'skip',
      status: 'size_skipped',
      verdictHint: 'size>100',
    });
  });

  test('queues scans when scanOnIngest is enabled', () => {
    env.scan.enabled = true;
    env.scan.maxAttachmentBytesForScan = 2048;
    env.scan.scanOnIngest = true;

    const result = getAttachmentScanDecision(512);
    assert.deepEqual(result, {
      disposition: 'queued',
      status: 'pending',
    });
  });

  test('runs inline scans when scanOnIngest is disabled', () => {
    env.scan.enabled = true;
    env.scan.maxAttachmentBytesForScan = 2048;
    env.scan.scanOnIngest = false;

    const result = getAttachmentScanDecision(512);
    assert.deepEqual(result, {
      disposition: 'inline',
      status: 'pending',
    });
  });
} finally {
  env.scan.enabled = original.enabled;
  env.scan.maxAttachmentBytesForScan = original.maxAttachmentBytesForScan;
  env.scan.scanOnIngest = original.scanOnIngest;
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
