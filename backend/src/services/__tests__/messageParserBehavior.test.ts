import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import PostalMime from 'postal-mime';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { blobStore } from '../../storage/seaweedS3BlobStore.js';
import { parseAndPersistMessage } from '../messageParser.js';
import { createQueue } from '../queue.js';

type QueryCall = {
  text: string;
  params: any[];
};

type QueryStep = {
  rows?: any[];
  check?: (call: QueryCall) => void;
};

const withMockedQueries = async (
  steps: QueryStep[],
  fn: (calls: QueryCall[]) => Promise<void> | void,
) => {
  const calls: QueryCall[] = [];
  const originalQuery = pool.query.bind(pool);
  let index = 0;

  (pool as any).query = async (text: string, params: any[] = []) => {
    const call = { text: String(text), params: Array.isArray(params) ? params : [] };
    calls.push(call);
    const step = steps[index];
    if (!step) {
      throw new Error(`Unexpected query #${index + 1}: ${call.text}`);
    }
    index += 1;
    step.check?.(call);
    return { rows: step.rows ?? [] };
  };

  try {
    await fn(calls);
    assert.equal(index, steps.length, `Expected ${steps.length} query calls, got ${index}`);
  } finally {
    (pool as any).query = originalQuery;
  }
};

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

const withMockedBlobStore = async (
  fn: (captures: { putCalls: Array<{ key: string; size: number; mimeType: string }>; deletedKeys: string[] }) => Promise<void> | void,
) => {
  const putCalls: Array<{ key: string; size: number; mimeType: string }> = [];
  const deletedKeys: string[] = [];
  const originalPutObject = blobStore.putObject.bind(blobStore);
  const originalDeleteObject = blobStore.deleteObject.bind(blobStore);

  (blobStore as any).putObject = async (key: string, data: Buffer, mimeType: string) => {
    putCalls.push({ key, size: data.length, mimeType });
    return { key, mimeType, size: data.length };
  };
  (blobStore as any).deleteObject = async (key: string) => {
    deletedKeys.push(key);
  };

  try {
    await fn({ putCalls, deletedKeys });
  } finally {
    (blobStore as any).putObject = originalPutObject;
    (blobStore as any).deleteObject = originalDeleteObject;
  }
};

class FakeSocket extends EventEmitter {
  destroyed = false;
  timeoutMs: number | null = null;

  setTimeout(ms: number) {
    this.timeoutMs = ms;
  }

  write(_chunk: string | Buffer) {}

  end() {
    this.destroyed = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

const withMockedClamConnection = async (
  onCreate: (socket: FakeSocket, index: number) => void,
  fn: () => Promise<void> | void,
) => {
  const originalCreateConnection = net.createConnection;
  let index = 0;
  (net as any).createConnection = (_opts: any, onConnect?: () => void) => {
    index += 1;
    const socket = new FakeSocket();
    onCreate(socket, index);
    process.nextTick(() => onConnect?.());
    return socket;
  };
  try {
    await fn();
  } finally {
    (net as any).createConnection = originalCreateConnection;
  }
};

const withMockedPostalParse = async (
  parsed: Record<string, any>,
  fn: () => Promise<void> | void,
) => {
  const originalParse = PostalMime.prototype.parse;
  (PostalMime.prototype as any).parse = async () => parsed;
  try {
    await fn();
  } finally {
    PostalMime.prototype.parse = originalParse;
  }
};

const withMockedQueueAddJob = async (
  addJobImpl: (task: string, payload: Record<string, any>, options: Record<string, any>) => Promise<void> | void,
  fn: () => Promise<void> | void,
) => {
  const queue = await createQueue();
  const originalAddJob = (queue as any).addJob;
  (queue as any).addJob = async (task: string, payload: Record<string, any>, options: Record<string, any>) =>
    addJobImpl(task, payload, options);
  try {
    await fn();
  } finally {
    (queue as any).addJob = originalAddJob;
  }
};

const multipartSource = Buffer.from([
  'From: Alice <alice@example.com>',
  'To: Bob <bob@example.com>',
  'Subject: Demo',
  'Message-ID: <msg-1@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'Body text line',
  '--b',
  'Content-Type: text/plain; name="bad/name.txt"',
  'Content-Disposition: attachment; filename="bad/name.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  'aGVsbG8gYXR0YWNobWVudA==',
  '--b--',
  '',
].join('\r\n'));

const plainTextSource = Buffer.from([
  'From: Alice <alice@example.com>',
  'To: Bob <bob@example.com>',
  'Subject: Ping',
  'Message-ID: <msg-2@example.com>',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'Simple body',
  '',
].join('\r\n'));

await test('parses MIME message, rewrites attachment blobs, and emits parse sync event', async () => {
  const originalScanEnabled = env.scan.enabled;
  env.scan.enabled = false;

  try {
    await withMockedBlobStore(async ({ putCalls, deletedKeys }) => {
      await withMockedQueries(
        [
          {
            check: (call) => {
              assert.match(call.text, /UPDATE messages/);
              assert.equal(call.params[0], 'msg-1');
              assert.equal(typeof call.params[1], 'string');
              assert.equal(call.params[3], 'Demo');
              assert.equal(call.params[4], 'Alice alice@example.com');
              assert.equal(call.params[5], 'Bob bob@example.com');
              assert.equal(call.params[6], '<msg-1@example.com>');
            },
          },
          {
            rows: [{ blob_key: 'old-blob-1' }, { blob_key: null }, { blob_key: 'old-blob-2' }],
            check: (call) => {
              assert.match(call.text, /SELECT blob_key/);
              assert.deepEqual(call.params, ['msg-1']);
            },
          },
          {
            check: (call) => {
              assert.equal(call.text, 'DELETE FROM attachments WHERE message_id = $1');
              assert.deepEqual(call.params, ['msg-1']);
            },
          },
          {
            rows: [{ id: 'new-att-1' }],
            check: (call) => {
              assert.match(call.text, /INSERT INTO attachments/);
              assert.equal(call.params[0], 'msg-1');
              assert.equal(call.params[1], 'bad/name.txt');
              assert.equal(call.params[2], 'text/plain');
              assert.ok(typeof call.params[3] === 'number' && call.params[3] > 0);
              assert.equal(call.params[5], false);
              assert.equal(call.params[6], 'disabled');
              assert.equal(call.params[7], 'scanner-disabled');
              assert.ok(String(call.params[8]).includes('hello attachment'));
            },
          },
          {
            rows: [{ incoming_connector_id: 'conn-1' }],
            check: (call) => {
              assert.equal(call.text, 'SELECT incoming_connector_id FROM messages WHERE id = $1');
              assert.deepEqual(call.params, ['msg-1']);
            },
          },
          {
            rows: [{ id: '0', user_id: null }],
            check: (call) => {
              assert.match(call.text, /INSERT INTO sync_events/);
              assert.deepEqual(call.params.slice(0, 2), ['conn-1', 'message_parsed']);
            },
          },
        ],
        async () => {
          const parsed = await parseAndPersistMessage('msg-1', multipartSource);
          assert.equal(parsed.attachmentCount, 1);
        },
      );

      assert.deepEqual(deletedKeys.sort(), ['old-blob-1', 'old-blob-2']);
      assert.equal(putCalls.length, 1);
      assert.equal(putCalls[0]?.mimeType, 'text/plain');
      assert.ok(putCalls[0]?.size > 0);
      assert.ok(putCalls[0]?.key.startsWith('attachments/msg-1/'));
      assert.ok(putCalls[0]?.key.endsWith('-bad_name.txt'));
    });
  } finally {
    env.scan.enabled = originalScanEnabled;
  }
});

await test('handles plain text message without attachments or existing blobs', async () => {
  const originalScanEnabled = env.scan.enabled;
  env.scan.enabled = false;

  try {
    await withMockedBlobStore(async ({ putCalls, deletedKeys }) => {
      await withMockedQueries(
        [
          {
            check: (call) => {
              assert.match(call.text, /UPDATE messages/);
              assert.equal(call.params[0], 'msg-2');
              assert.equal(call.params[3], 'Ping');
            },
          },
          {
            rows: [],
            check: (call) => {
              assert.match(call.text, /SELECT blob_key/);
              assert.deepEqual(call.params, ['msg-2']);
            },
          },
          {
            rows: [],
            check: (call) => {
              assert.equal(call.text, 'SELECT incoming_connector_id FROM messages WHERE id = $1');
              assert.deepEqual(call.params, ['msg-2']);
            },
          },
        ],
        async () => {
          const parsed = await parseAndPersistMessage('msg-2', plainTextSource);
          assert.equal(parsed.attachmentCount, 0);
        },
      );

      assert.equal(putCalls.length, 0);
      assert.equal(deletedKeys.length, 0);
    });
  } finally {
    env.scan.enabled = originalScanEnabled;
  }
});

await test('queues attachment scans and handles attachment content/search-text edge cases', async () => {
  const originalScanEnabled = env.scan.enabled;
  const originalScanOnIngest = env.scan.scanOnIngest;
  const originalMaxAttachmentBytesForScan = env.scan.maxAttachmentBytesForScan;
  env.scan.enabled = true;
  env.scan.scanOnIngest = true;
  env.scan.maxAttachmentBytesForScan = 5;

  const queuedJobs: Array<{ task: string; payload: Record<string, any>; options: Record<string, any> }> = [];
  try {
    await withMockedQueueAddJob(
      async (task, payload, options) => {
        queuedJobs.push({ task, payload, options });
      },
      async () => {
        await withMockedPostalParse(
          {
            text: 'Body',
            html: null,
            subject: 'Queued Attachments',
            from: 'Queued Sender <queued@example.com>',
            to: 'Recipient <recipient@example.com>',
            messageId: '<queued@example.com>',
            inReplyTo: null,
            references: null,
            headers: [{ key: 'X-Test', value: '1' }],
            attachments: [
              {
                filename: 'notes.md',
                mimeType: 'application/octet-stream',
                content: 'YWJj',
                encoding: 'base64',
              },
              {
                filename: 'photo.png',
                mimeType: 'image/png',
                content: Buffer.from('png'),
              },
              {
                filename: 'big.txt',
                mimeType: 'text/plain',
                content: Buffer.alloc(6, 'a'),
              },
              {
                filename: 'blank.txt',
                mimeType: 'text/plain',
                content: new Uint8Array([0x20, 0x20, 0x20]).buffer,
              },
            ],
          },
          async () => {
            await withMockedBlobStore(async ({ putCalls, deletedKeys }) => {
              await withMockedQueries(
                [
                  {
                    check: (call) => {
                      assert.match(call.text, /UPDATE messages/);
                      assert.equal(call.params[0], 'msg-queued');
                    },
                  },
                  {
                    rows: [],
                    check: (call) => {
                      assert.match(call.text, /SELECT blob_key/);
                      assert.deepEqual(call.params, ['msg-queued']);
                    },
                  },
                  {
                    rows: [{ id: 'queued-1' }],
                    check: (call) => {
                      assert.match(call.text, /INSERT INTO attachments/);
                      assert.equal(call.params[1], 'notes.md');
                      assert.equal(call.params[6], 'pending');
                      assert.equal(call.params[7], null);
                      assert.equal(call.params[8], 'abc');
                    },
                  },
                  {
                    rows: [{ id: 'queued-2' }],
                    check: (call) => {
                      assert.equal(call.params[1], 'photo.png');
                      assert.equal(call.params[8], null);
                    },
                  },
                  {
                    rows: [{ id: 'queued-3' }],
                    check: (call) => {
                      assert.equal(call.params[1], 'big.txt');
                      assert.equal(call.params[6], 'size_skipped');
                      assert.match(String(call.params[7]), /^size>/);
                      assert.equal(call.params[8], null);
                    },
                  },
                  {
                    rows: [{ id: 'queued-4' }],
                    check: (call) => {
                      assert.equal(call.params[1], 'blank.txt');
                      assert.equal(call.params[8], null);
                    },
                  },
                  {
                    rows: [],
                    check: (call) => {
                      assert.equal(call.text, 'SELECT incoming_connector_id FROM messages WHERE id = $1');
                      assert.deepEqual(call.params, ['msg-queued']);
                    },
                  },
                ],
                async () => {
                  const parsed = await parseAndPersistMessage('msg-queued', Buffer.from('ignored raw source'));
                  assert.equal(parsed.attachmentCount, 4);
                },
              );

              assert.equal(putCalls.length, 4);
              assert.equal(putCalls[0]?.size, 3);
              assert.deepEqual(deletedKeys, []);
            });
          },
        );
      },
    );

    assert.equal(queuedJobs.length, 3);
    assert.deepEqual(
      queuedJobs.map((job) => job.task),
      ['scanAttachment', 'scanAttachment', 'scanAttachment'],
    );
    assert.deepEqual(
      queuedJobs.map((job) => job.payload.messageId),
      ['msg-queued', 'msg-queued', 'msg-queued'],
    );
  } finally {
    env.scan.enabled = originalScanEnabled;
    env.scan.scanOnIngest = originalScanOnIngest;
    env.scan.maxAttachmentBytesForScan = originalMaxAttachmentBytesForScan;
  }
});

await test('records inline scan success and scan errors without aborting parsing', async () => {
  const originalScanEnabled = env.scan.enabled;
  const originalScanOnIngest = env.scan.scanOnIngest;
  const originalClamTimeout = env.scan.clamTimeoutMs;
  env.scan.enabled = true;
  env.scan.scanOnIngest = false;
  env.scan.clamTimeoutMs = 500;

  try {
    await withMockedClamConnection(
      (socket, index) => {
        socket.write = (chunk: string | Buffer) => {
          if (Buffer.isBuffer(chunk) && chunk.length === 4 && chunk.readUInt32BE(0) === 0) {
            process.nextTick(() => {
              if (index === 1) {
                socket.emit('data', Buffer.from('stream: OK\n'));
              } else {
                socket.emit('error', new Error('clamd unavailable'));
              }
            });
          }
        };
      },
      async () => {
        await withMockedPostalParse(
          {
            text: 'Body',
            html: null,
            subject: 'Inline Scan',
            from: 'Inline Sender <inline@example.com>',
            to: 'Recipient <recipient@example.com>',
            messageId: '<inline@example.com>',
            inReplyTo: null,
            references: null,
            headers: [],
            attachments: [
              {
                filename: 'safe.txt',
                mimeType: 'text/plain',
                content: Buffer.from('safe'),
              },
              {
                filename: 'unsafe.txt',
                mimeType: 'text/plain',
                content: Buffer.from('unsafe'),
              },
            ],
          },
          async () => {
            await withMockedBlobStore(async () => {
              await withMockedQueries(
                [
                  {
                    check: (call) => {
                      assert.match(call.text, /UPDATE messages/);
                      assert.equal(call.params[0], 'msg-inline');
                    },
                  },
                  {
                    rows: [],
                  },
                  {
                    rows: [{ id: 'inline-1' }],
                    check: (call) => {
                      assert.equal(call.params[1], 'safe.txt');
                      assert.equal(call.params[6], 'clean');
                      assert.match(String(call.params[7]), /OK/i);
                    },
                  },
                  {
                    rows: [{ id: 'inline-2' }],
                    check: (call) => {
                      assert.equal(call.params[1], 'unsafe.txt');
                      assert.equal(call.params[6], 'error');
                      assert.match(String(call.params[7]), /clamd unavailable/i);
                    },
                  },
                  {
                    rows: [],
                  },
                ],
                async () => {
                  const parsed = await parseAndPersistMessage('msg-inline', Buffer.from('ignored raw source'));
                  assert.equal(parsed.attachmentCount, 2);
                },
              );
            });
          },
        );
      },
    );
  } finally {
    env.scan.enabled = originalScanEnabled;
    env.scan.scanOnIngest = originalScanOnIngest;
    env.scan.clamTimeoutMs = originalClamTimeout;
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
