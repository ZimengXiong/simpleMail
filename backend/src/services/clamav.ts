import net from 'node:net';
import { env } from '../config/env.js';

const connectToClamD = (): Promise<net.Socket> => {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: env.scan.clamHost, port: env.scan.clamPort }, () => {
      resolve(socket);
    });

    socket.once('error', (err) => {
      reject(err);
    });
  });
};

const readClamLine = (socket: net.Socket): Promise<string> => {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) {
        const line = buffer.split('\n')[0].trim();
        cleanup();
        resolve(line);
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };

    socket.on('data', onData);
    socket.once('error', onError);
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

  const socket = await connectToClamD();
  socket.write('zINSTREAM\0');

  writeUInt32BE(socket, buffer.length);
  socket.write(buffer);
  writeUInt32BE(socket, 0);

  const response = await readClamLine(socket);
  socket.end();

  const normalized = response.toUpperCase();
  if (normalized.includes('OK')) {
    return { safe: true, verdict: response };
  }

  if (normalized.includes('FOUND')) {
    return { safe: false, verdict: response };
  }

  return { safe: false, verdict: response };
};
