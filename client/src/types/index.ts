export type Provider = 'gmail' | 'imap' | 'smtp';
export type AuthType = 'oauth2' | 'password';
export type ScanStatus = 'pending' | 'clean' | 'infected' | 'disabled' | 'size_skipped' | 'error' | 'missing';
export type SendStatus = 'queued' | 'in_flight' | 'succeeded' | 'failed';

export interface IncomingConnectorRecord {
  id: string;
  name: string;
  emailAddress: string;
  provider: Provider;
  host: string | null;
  port: number | null;
  tls: boolean | null;
  authConfig: any;
  syncSettings: any;
  visual_config?: { icon?: string; emoji?: string };
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutgoingConnectorRecord {
  id: string;
  name: string;
  provider: Provider;
  fromAddress: string;
  host: string | null;
  port: number | null;
  tlsMode: string;
  authConfig: any;
  fromEnvelopeDefaults: any;
  sentCopyBehavior: any;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityRecord {
  id: string;
  displayName: string;
  emailAddress: string;
  signature: string | null;
  outgoingConnectorId: string;
  sentToIncomingConnectorId: string | null;
  replyTo: string | null;
  visual_config?: { icon?: string; emoji?: string };
}

export interface AttachmentRecord {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  size: number;
  blobKey: string;
  scanStatus: ScanStatus;
  scanResult: string | null;
  scannedAt: string | null;
}

export interface MessageRecord {
  id: string;
  incomingConnectorId: string;
  messageId: string;
  subject: string | null;
  fromHeader: string | null;
  toHeader: string | null;
  ccHeader?: string | null;
  bccHeader?: string | null;
  threadId: string | null;
  folderPath: string;
  rawBlobKey: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  receivedAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  attachments?: AttachmentRecord[];
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  threadCount?: number;
  participants?: string[];
  sendStatus?: SendStatus;
  sendError?: string | null;
  sendOnlyNoResponses?: boolean;
}

export interface MailboxInfo {
  name: string;
  path: string;
  delimiter: string;
  parent: string | null;
  flags: string[];
  specialUse?: string;
}

export interface MailboxSyncState {
  status: 'idle' | 'queued' | 'syncing' | 'cancel_requested' | 'cancelled' | 'completed' | 'error';
  lastSeenUid: number;
  highestUid?: number;
  lastFullReconcileAt?: string | null;
  mailboxUidValidity: string | null;
  modseq: string | null;
  syncStartedAt: string | null;
  syncCompletedAt: string | null;
  syncError: string | null;
  syncProgress: {
    inserted: number;
    updated: number;
    reconciledRemoved: number;
    metadataRefreshed: number;
  };
}

export interface ConnectorSyncStatesResponse {
  connectorId: string;
  states: Array<MailboxSyncState & { mailbox: string }>;
}

export interface UserRecord {
  id: string;
  email: string;
  token: string;
}
