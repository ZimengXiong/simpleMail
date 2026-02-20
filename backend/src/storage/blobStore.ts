import type { Readable } from 'node:stream';

export interface StoredBlob {
  key: string;
  mimeType: string;
  size: number;
}

export interface BlobStream {
  stream: Readable;
  size: number | null;
  mimeType: string | null;
}

export interface BlobStore {
  putObject(key: string, data: Buffer, mimeType: string): Promise<StoredBlob>;
  getObject(key: string): Promise<Buffer | null>;
  getObjectStream(key: string): Promise<BlobStream | null>;
  deleteObject(key: string): Promise<void>;
}
