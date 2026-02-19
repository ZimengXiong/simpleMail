export type Provider = 'gmail' | 'imap' | 'smtp';
export type AuthType = 'oauth2' | 'password';

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
}

export interface MessageRecord {
  id: string;
  incomingConnectorId: string;
  messageId: string;
  subject: string | null;
  fromHeader: string | null;
  toHeader: string | null;
  threadId: string | null;
  folderPath: string;
  rawBlobKey: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  receivedAt: string | null;
  isRead: boolean;
  isStarred: boolean;
}

export interface MailboxInfo {
  name: string;
  path: string;
  delimiter: string;
  parent: string | null;
  flags: string[];
  specialUse?: string;
}
