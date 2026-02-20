import net from 'node:net';
import { env } from '../config/env.js';

const DEFAULT_CLAM_TIMEOUT_MS = 15_000;
const MAX_CLAM_TIMEOUT_MS = 120_000;
const MAX_CLAMD_RESPONSE_BYTES = 64 * 1024;

const resolveClamTimeoutMs = () => {
  if (!Number.isFinite(env.scan.clamTimeoutMs) || env.scan.clamTimeoutMs <= 0) {
    return DEFAULT_CLAM_TIMEOUT_MS;
  }
  return Math.min(Math.floor(env.scan.clamTimeoutMs), MAX_CLAM_TIMEOUT_MS);
};

const connectToClamD = (timeoutMs: number): Promise<net.Socket> => {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: env.scan.clamHost, port: env.scan.clamPort }, () => {
      socket.setTimeout(timeoutMs);
      resolve(socket);
    });

    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`clamd connect timed out after ${timeoutMs}ms`));
    });

    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
};

const readClamLine = (socket: net.Socket, timeoutMs: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`clamd response timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_CLAMD_RESPONSE_BYTES) {
        cleanup();
        socket.destroy();
        reject(new Error('clamd response exceeded maximum length'));
        return;
      }
      if (buffer.includes('\n')) {
        const line = buffer.split('\n')[0].trim();
        if (!line) {
          cleanup();
          reject(new Error('clamd returned an empty response'));
          return;
        }
        cleanup();
        resolve(line);
      }
    };

    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error(`clamd response timed out after ${timeoutMs}ms`));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onEnd = () => {
      cleanup();
      reject(new Error('clamd closed connection before returning a result'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('timeout', onTimeout);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };

    socket.on('data', onData);
    socket.once('timeout', onTimeout);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
};

const writeUInt32BE = (socket: net.Socket, value: number) => {
  const chunk = Buffer.alloc(4);
  chunk.writeUInt32BE(value, 0);
  socket.write(chunk);
};

export const scanBuffer = async (buffer: Buffer): Promise<{ safe: boolean; verdict: string }> => {
  if (!env.scan.enabled) {
    return { safe: true, verdict: 'scanner-disabled' };
  }

  if (buffer.length > 0xffffffff) {
    throw new Error('attachment is too large for clamd INSTREAM scan');
  }

  const timeoutMs = resolveClamTimeoutMs();
  const socket = await connectToClamD(timeoutMs);

  let response = '';
  try {
    socket.write('zINSTREAM\0');
    writeUInt32BE(socket, buffer.length);
    socket.write(buffer);
    writeUInt32BE(socket, 0);
    response = await readClamLine(socket, timeoutMs);
  } finally {
    if (!socket.destroyed) {
      socket.end();
    }
  }

  const normalized = response.toUpperCase();
  if (normalized.includes('OK')) {
    return { safe: true, verdict: response };
  }

  if (normalized.includes('FOUND')) {
    return { safe: false, verdict: response };
  }

  return { safe: false, verdict: response };
};
