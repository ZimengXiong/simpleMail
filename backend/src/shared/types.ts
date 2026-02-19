export type Provider = 'gmail' | 'imap' | 'smtp';
export type AuthType = 'oauth2' | 'password';

export interface ConnectorAuthConfig {
  authType: AuthType;
  username?: string;
  password?: string;
  refreshToken?: string;
  accessToken?: string;
  tokenExpiresAt?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  scope?: string;
}

export interface IncomingConnectorRecord {
  id: string;
  userId: string;
  name: string;
  emailAddress: string;
  provider: Provider;
  host: string | null;
  port: number | null;
  tls: boolean | null;
  authConfig: Record<string, any>;
  syncSettings: Record<string, any>;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutgoingConnectorRecord {
  id: string;
  userId: string;
  name: string;
  provider: Provider;
  fromAddress: string;
  host: string | null;
  port: number | null;
  tlsMode: string;
  authConfig: Record<string, any>;
  fromEnvelopeDefaults: Record<string, any>;
  sentCopyBehavior: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityRecord {
  id: string;
  userId: string;
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
  inReplyTo?: string | null;
  referencesHeader?: string | null;
}
