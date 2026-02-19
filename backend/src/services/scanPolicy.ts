import { env } from '../config/env.js';

export type ScanDisposition = 'skip' | 'inline' | 'queued';

export interface ScanPolicyDecision {
  disposition: ScanDisposition;
  status: string;
  verdictHint?: string | null;
}

export const getAttachmentScanDecision = (sizeBytes: number): ScanPolicyDecision => {
  if (!env.scan.enabled) {
    return {
      disposition: 'skip',
      status: 'disabled',
      verdictHint: 'scanner-disabled',
    };
  }

  if (sizeBytes > env.scan.maxAttachmentBytesForScan) {
    return {
      disposition: 'skip',
      status: 'size_skipped',
      verdictHint: `size>${env.scan.maxAttachmentBytesForScan}`,
    };
  }

  if (env.scan.scanOnIngest) {
    return {
      disposition: 'queued',
      status: 'pending',
    };
  }

  return {
    disposition: 'inline',
    status: 'pending',
  };
};
