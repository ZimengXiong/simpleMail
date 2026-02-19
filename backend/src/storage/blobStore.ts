export interface StoredBlob {
  key: string;
  mimeType: string;
  size: number;
}

export interface BlobStore {
  putObject(key: string, data: Buffer, mimeType: string): Promise<StoredBlob>;
  getObject(key: string): Promise<Buffer | null>;
  deleteObject(key: string): Promise<void>;
}
