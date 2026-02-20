import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { env } from '../../config/env.js';
import { scanBuffer } from '../clamav.js';

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: Array<string | Buffer> = [];
  timeoutMs: number | null = null;

  setTimeout(ms: number) {
    this.timeoutMs = ms;
  }

  write(chunk: string | Buffer) {
    this.writes.push(chunk);
  }

  end() {
    this.destroyed = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

const withMockedConnection = async (
  onCreate: (socket: FakeSocket) => void,
  optionsOrFn: { autoConnect?: boolean } | (() => Promise<void> | void),
  maybeFn?: () => Promise<void> | void,
) => {
  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  if (!fn) {
    throw new Error('withMockedConnection requires a callback');
  }
  const autoConnect = options.autoConnect ?? true;
  const originalCreateConnection = net.createConnection;
  (net as any).createConnection = (_opts: any, onConnect?: () => void) => {
    const socket = new FakeSocket();
    onCreate(socket);
    if (autoConnect) {
      process.nextTick(() => {
        onConnect?.();
      });
    }
    return socket;
  };

  try {
    await fn();
  } finally {
    (net as any).createConnection = originalCreateConnection;
  }
};

const withScanConfig = async (
  updates: { enabled?: boolean; clamTimeoutMs?: number },
  fn: () => Promise<void> | void,
) => {
  const originalEnabled = env.scan.enabled;
  const originalTimeout = env.scan.clamTimeoutMs;
  if (typeof updates.enabled === 'boolean') {
    env.scan.enabled = updates.enabled;
  }
  if (typeof updates.clamTimeoutMs === 'number') {
    env.scan.clamTimeoutMs = updates.clamTimeoutMs;
  }
  try {
    await fn();
  } finally {
    env.scan.enabled = originalEnabled;
    env.scan.clamTimeoutMs = originalTimeout;
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

await test('returns scanner-disabled verdict when scanning is disabled', async () => {
  const originalEnabled = env.scan.enabled;
  env.scan.enabled = false;
  try {
    const result = await scanBuffer(Buffer.from('hello'));
    assert.deepEqual(result, { safe: true, verdict: 'scanner-disabled' });
  } finally {
    env.scan.enabled = originalEnabled;
  }
});

await test('rejects buffers that exceed clamd INSTREAM max size', async () => {
  const originalEnabled = env.scan.enabled;
  env.scan.enabled = true;
  try {
    const huge = {
      length: 0x1_0000_0000,
    } as Buffer;
    await assert.rejects(
      scanBuffer(huge),
      /too large/i,
    );
  } finally {
    env.scan.enabled = originalEnabled;
  }
});

await test('parses clamd OK and FOUND responses', async () => {
  const originalEnabled = env.scan.enabled;
  const originalTimeout = env.scan.clamTimeoutMs;
  env.scan.enabled = true;
  env.scan.clamTimeoutMs = 1000;

  try {
    await withMockedConnection(
      (socket) => {
        socket.write = (chunk: string | Buffer) => {
          socket.writes.push(chunk);
          if (Buffer.isBuffer(chunk) && chunk.length === 4 && chunk.readUInt32BE(0) === 0) {
            process.nextTick(() => {
              socket.emit('data', Buffer.from('stream: OK\n'));
            });
          }
        };
      },
      async () => {
        const result = await scanBuffer(Buffer.from('safe'));
        assert.equal(result.safe, true);
        assert.match(result.verdict, /OK/);
      },
    );

    await withMockedConnection(
      (socket) => {
        socket.write = (chunk: string | Buffer) => {
          socket.writes.push(chunk);
          if (Buffer.isBuffer(chunk) && chunk.length === 4 && chunk.readUInt32BE(0) === 0) {
            process.nextTick(() => {
              socket.emit('data', Buffer.from('stream: Eicar-Test-Signature FOUND\n'));
            });
          }
        };
      },
      async () => {
        const result = await scanBuffer(Buffer.from('infected'));
        assert.equal(result.safe, false);
        assert.match(result.verdict, /FOUND/);
      },
    );
  } finally {
    env.scan.enabled = originalEnabled;
    env.scan.clamTimeoutMs = originalTimeout;
  }
});

await test('rejects when clamd connection times out before connect callback', async () => {
  await withScanConfig({ enabled: true, clamTimeoutMs: 25 }, async () => {
    await withMockedConnection(
      (socket) => {
        process.nextTick(() => socket.emit('timeout'));
      },
      { autoConnect: false },
      async () => {
        await assert.rejects(scanBuffer(Buffer.from('x')), /connect timed out/i);
      },
    );
  });
});

await test('rejects when clamd connection emits error before connect callback', async () => {
  await withScanConfig({ enabled: true, clamTimeoutMs: 25 }, async () => {
    await withMockedConnection(
      (socket) => {
        process.nextTick(() => socket.emit('error', new Error('connect failed')));
      },
      { autoConnect: false },
      async () => {
        await assert.rejects(scanBuffer(Buffer.from('x')), /connect failed/i);
      },
    );
  });
});

await test('rejects when clamd response exceeds maximum length', async () => {
  await withScanConfig({ enabled: true, clamTimeoutMs: 50 }, async () => {
    await withMockedConnection(
      (socket) => {
        socket.write = (chunk: string | Buffer) => {
          if (Buffer.isBuffer(chunk) && chunk.length === 4 && chunk.readUInt32BE(0) === 0) {
            process.nextTick(() => socket.emit('data', Buffer.alloc(70 * 1024, 'x')));
          }
        };
      },
      async () => {
        await assert.rejects(scanBuffer(Buffer.from('oversized-response')), /exceeded maximum length/i);
      },
    );
  });
});

await test('rejects when clamd returns an empty response line', async () => {
  await withScanConfig({ enabled: true, clamTimeoutMs: 50 }, async () => {
    await withMockedConnection(
      (socket) => {
        socket.write = (chunk: string | Buffer) => {
          if (Buffer.isBuffer(chunk) && chunk.length === 4 && chunk.readUInt32BE(0) === 0) {
            process.nextTick(() => socket.emit('data', Buffer.from('\n')));
          }
        };
      },
      async () => {
        await assert.rejects(scanBuffer(Buffer.from('empty-line')), /empty response/i);
      },
    );
  });
});

await test('rejects when clamd does not respond before timeout', async () => {
  await withScanConfig({ enabled: true, clamTimeoutMs: 25 }, async () => {
    await withMockedConnection(
      () => {},
      async () => {
        await assert.rejects(scanBuffer(Buffer.from('no-response')), /response timed out/i);
      },
    );
  });
});

await test('rejects when response socket times out while waiting for line', async () => {
  await withScanConfig({ enabled: true, clamTimeoutMs: 50 }, async () => {
    await withMockedConnection(
      (socket) => {
        socket.write = (chunk: string | Buffer) => {
          if (Buffer.isBuffer(chunk) && chunk.length === 4 && chunk.readUInt32BE(0) === 0) {
            process.nextTick(() => socket.emit('timeout'));
          }
        };
      },
      async () => {
        await assert.rejects(scanBuffer(Buffer.from('socket-timeout')), /response timed out/i);
      },
    );
  });
});

await test('rejects when response socket emits an error while waiting for line', async () => {
  await withScanConfig({ enabled: true, clamTimeoutMs: 50 }, async () => {
    await withMockedConnection(
      (socket) => {
        socket.write = (chunk: string | Buffer) => {
          if (Buffer.isBuffer(chunk) && chunk.length === 4 && chunk.readUInt32BE(0) === 0) {
            process.nextTick(() => socket.emit('error', new Error('read failed')));
          }
        };
      },
      async () => {
        await assert.rejects(scanBuffer(Buffer.from('socket-error')), /read failed/i);
      },
    );
  });
});

await test('rejects when clamd closes socket before returning a result', async () => {
  await withScanConfig({ enabled: true, clamTimeoutMs: 50 }, async () => {
    await withMockedConnection(
      (socket) => {
        socket.write = (chunk: string | Buffer) => {
          if (Buffer.isBuffer(chunk) && chunk.length === 4 && chunk.readUInt32BE(0) === 0) {
            process.nextTick(() => socket.emit('end'));
          }
        };
      },
      async () => {
        await assert.rejects(scanBuffer(Buffer.from('socket-end')), /closed connection before returning a result/i);
      },
    );
  });
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
