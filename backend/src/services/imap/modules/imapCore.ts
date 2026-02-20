export {
  setSyncState,
  ensureIncomingConnectorState,
  normalizeGmailMailboxPath,
  getGmailMailboxPathAliases,
  resolveImapTlsModeForConnector,
  isGmailHistoryTooOldError,
  shouldResetMailboxForUidValidity,
  getImapClient,
  getMailboxState,
} from '../imap/imapService.monolith.js';
