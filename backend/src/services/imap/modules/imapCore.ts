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
} from '../imapService.monolith.js';
