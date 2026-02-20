import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SeaweedS3BlobStore } from '../seaweedS3BlobStore.js';

type SendCall = {
  command: any;
};

const withMockedS3Send = async (
  handler: (command: any, calls: SendCall[]) => Promise<any> | any,
  fn: (calls: SendCall[]) => Promise<void> | void,
) => {
  const calls: SendCall[] = [];
  const originalSend = S3Client.prototype.send;
  (S3Client.prototype as any).send = async function mockedSend(command: any) {
    calls.push({ command });
    return handler(command, calls);
  };

  try {
    await fn(calls);
  } finally {
    S3Client.prototype.send = originalSend;
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

await test('putObject ensures bucket and uploads object metadata', async () => {
  await withMockedS3Send(
    async (command) => {
      if (command instanceof HeadBucketCommand) {
        return {};
      }
      if (command instanceof PutObjectCommand) {
        return {};
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
    async (calls) => {
      const store = new SeaweedS3BlobStore();
      const payload = Buffer.from('hello world');
      const saved = await store.putObject('attachments/a.txt', payload, 'text/plain');

      assert.deepEqual(saved, { key: 'attachments/a.txt', mimeType: 'text/plain', size: payload.length });
      assert.equal(calls.some((call) => call.command instanceof HeadBucketCommand), true);
      assert.equal(calls.some((call) => call.command instanceof PutObjectCommand), true);
    },
  );
});

await test('ensureBucket creates bucket when head lookup fails', async () => {
  await withMockedS3Send(
    async (command) => {
      if (command instanceof HeadBucketCommand) {
        throw new Error('bucket missing');
      }
      if (command instanceof CreateBucketCommand) {
        return {};
      }
      return {};
    },
    async (calls) => {
      const store = new SeaweedS3BlobStore();
      await store.ensureBucket();
      assert.equal(calls.some((call) => call.command instanceof HeadBucketCommand), true);
      assert.equal(calls.some((call) => call.command instanceof CreateBucketCommand), true);
    },
  );
});

await test('ensureBucket deduplicates in-flight checks and reuses bucket-ready cache', async () => {
  let headCalls = 0;
  await withMockedS3Send(
    async (command) => {
      if (command instanceof HeadBucketCommand) {
        headCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {};
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
    async () => {
      const store = new SeaweedS3BlobStore();
      await Promise.all([store.ensureBucket(), store.ensureBucket()]);
      await store.ensureBucket();
      assert.equal(headCalls, 1);
    },
  );
});

await test('ensureBucket clears failed promise state and retries successfully', async () => {
  let createCalls = 0;
  await withMockedS3Send(
    async (command) => {
      if (command instanceof HeadBucketCommand) {
        throw new Error('bucket missing');
      }
      if (command instanceof CreateBucketCommand) {
        createCalls += 1;
        if (createCalls === 1) {
          throw new Error('create failed');
        }
        return {};
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
    async () => {
      const store = new SeaweedS3BlobStore();
      await assert.rejects(store.ensureBucket(), /create failed/i);
      await assert.doesNotReject(() => store.ensureBucket());
      assert.equal(createCalls, 2);
    },
  );
});

await test('getObjectStream/getObject read data and handle missing objects safely', async () => {
  await withMockedS3Send(
    async (command) => {
      if (command instanceof GetObjectCommand) {
        return {
          Body: Readable.from([Buffer.from('hello '), Buffer.from('blob')]),
          ContentLength: 10,
          ContentType: 'text/plain',
        };
      }
      return {};
    },
    async () => {
      const store = new SeaweedS3BlobStore();
      const streamed = await store.getObjectStream('attachments/a.txt');
      assert.ok(streamed);
      assert.equal(streamed?.size, 10);
      assert.equal(streamed?.mimeType, 'text/plain');

      const object = await store.getObject('attachments/a.txt');
      assert.equal(object?.toString('utf8'), 'hello blob');
    },
  );

  await withMockedS3Send(
    async (command) => {
      if (command instanceof GetObjectCommand) {
        throw new Error('not found');
      }
      return {};
    },
    async () => {
      const store = new SeaweedS3BlobStore();
      assert.equal(await store.getObjectStream('missing.txt'), null);
      assert.equal(await store.getObject('missing.txt'), null);
    },
  );
});

await test('getObjectStream returns null for unsupported body types and toNodeReadable handles edge inputs', async () => {
  await withMockedS3Send(
    async (command) => {
      if (command instanceof GetObjectCommand) {
        return {
          Body: { unsupported: true },
          ContentLength: 5,
          ContentType: 'text/plain',
        };
      }
      return {};
    },
    async () => {
      const store = new SeaweedS3BlobStore();
      const streamed = await store.getObjectStream('attachments/unsupported.txt');
      assert.equal(streamed, null);

      const internalStore = store as any;
      assert.equal(internalStore.toNodeReadable(null), null);
      assert.equal(internalStore.toNodeReadable({ notAStream: true }), null);

      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from('web-data')));
          controller.close();
        },
      });
      const webReadable = internalStore.toNodeReadable(webStream);
      assert.ok(webReadable);
      const webChunks: Buffer[] = [];
      for await (const chunk of webReadable as AsyncIterable<Uint8Array | Buffer>) {
        webChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      assert.equal(Buffer.concat(webChunks).toString('utf8'), 'web-data');

      const asyncIterable = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('async-');
          yield Buffer.from('iterable');
        },
      };
      const iterableReadable = internalStore.toNodeReadable(asyncIterable);
      assert.ok(iterableReadable);
      const iterableChunks: Buffer[] = [];
      for await (const chunk of iterableReadable as AsyncIterable<Uint8Array | Buffer>) {
        iterableChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      assert.equal(Buffer.concat(iterableChunks).toString('utf8'), 'async-iterable');
    },
  );
});

await test('deleteObject forwards delete command', async () => {
  await withMockedS3Send(
    async (command) => {
      if (command instanceof DeleteObjectCommand) {
        return {};
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
    async (calls) => {
      const store = new SeaweedS3BlobStore();
      await store.deleteObject('attachments/a.txt');
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.command instanceof DeleteObjectCommand, true);
    },
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
