import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { BlobStore, BlobStream, StoredBlob } from './blobStore.js';

export class SeaweedS3BlobStore implements BlobStore {
  private s3: S3Client;
  private bucketReady = false;
  private ensureBucketPromise: Promise<void> | null = null;

  constructor() {
    this.s3 = new S3Client({
      region: env.seaweed.region,
      endpoint: env.seaweed.endpoint,
      credentials: {
        accessKeyId: env.seaweed.accessKeyId,
        secretAccessKey: env.seaweed.secretAccessKey,
      },
      forcePathStyle: env.seaweed.forcePathStyle,
    });
  }

  async ensureBucket(): Promise<void> {
    if (this.bucketReady) {
      return;
    }
    if (this.ensureBucketPromise) {
      return this.ensureBucketPromise;
    }

    this.ensureBucketPromise = (async () => {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: env.seaweed.bucket }));
      } catch {
        await this.s3.send(new CreateBucketCommand({ Bucket: env.seaweed.bucket }));
      }
      this.bucketReady = true;
    })();

    try {
      await this.ensureBucketPromise;
    } catch (error) {
      this.bucketReady = false;
      throw error;
    } finally {
      this.ensureBucketPromise = null;
    }
  }

  async putObject(key: string, data: Buffer, mimeType: string): Promise<StoredBlob> {
    await this.ensureBucket();
    await this.s3.send(
      new PutObjectCommand({
        Bucket: env.seaweed.bucket,
        Key: key,
        Body: data,
        ContentType: mimeType,
      }),
    );
    return { key, mimeType, size: data.length };
  }

  private toNodeReadable(body: unknown): Readable | null {
    if (!body) {
      return null;
    }
    if (body instanceof Readable) {
      return body;
    }
    if (typeof (body as { getReader?: unknown }).getReader === 'function') {
      return Readable.fromWeb(body as any);
    }
    if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
      return Readable.from(body as AsyncIterable<Uint8Array>);
    }
    return null;
  }

  async getObjectStream(key: string): Promise<BlobStream | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: env.seaweed.bucket, Key: key }));
      const stream = this.toNodeReadable(res.Body);
      if (!stream) {
        return null;
      }
      return {
        stream,
        size: typeof res.ContentLength === 'number' ? res.ContentLength : null,
        mimeType: res.ContentType ?? null,
      };
    } catch {
      return null;
    }
  }

  async getObject(key: string): Promise<Buffer | null> {
    const streamed = await this.getObjectStream(key);
    if (!streamed) {
      return null;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of streamed.stream as AsyncIterable<Uint8Array | Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: env.seaweed.bucket, Key: key }));
  }
}

export const blobStore = new SeaweedS3BlobStore();
