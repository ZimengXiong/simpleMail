import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { BlobStore, StoredBlob } from './blobStore.js';

export class SeaweedS3BlobStore implements BlobStore {
  private s3: S3Client;

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
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: env.seaweed.bucket }));
      return;
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: env.seaweed.bucket }));
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

  async getObject(key: string): Promise<Buffer | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: env.seaweed.bucket, Key: key }));
      const body = res.Body;
      if (!body) return null;

      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }

      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: env.seaweed.bucket, Key: key }));
  }
}

export const blobStore = new SeaweedS3BlobStore();
