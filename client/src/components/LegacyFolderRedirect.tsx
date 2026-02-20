import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import {
  readPersistedInboxState,
  resolveInboxViewState,
  toInboxPath,
} from '../services/inboxStateMachine';

const normalizeConnectorId = (value: unknown): string => String(value ?? '').trim();
const normalizeSendEmail = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const LegacyFolderRedirect = () => {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const preferredInboxState = readPersistedInboxState();

  const seedParams = new URLSearchParams(searchParams);
  const folderPath = String(params['*'] ?? params.path ?? '').trim();
  if (folderPath && !seedParams.has('folder')) {
    seedParams.set('folder', folderPath);
  }

  const incomingConnectorIds = new Set<string>();
  const sendOnlyEmails = new Set<string>();

  const connectorId = normalizeConnectorId(seedParams.get('connectorId'));
  if (connectorId) {
    incomingConnectorIds.add(connectorId);
  }

  const profileToken = String(seedParams.get('profile') ?? '').trim().toLowerCase();
  const sendEmail = normalizeSendEmail(seedParams.get('sendEmail'));
  if (profileToken === 'send-only' && sendEmail) {
    sendOnlyEmails.add(sendEmail);
  }

  if (preferredInboxState?.profile.kind === 'incoming') {
    incomingConnectorIds.add(preferredInboxState.profile.connectorId);
  } else if (preferredInboxState?.profile.kind === 'send-only') {
    sendOnlyEmails.add(preferredInboxState.profile.sendEmail);
  }

  const resolved = resolveInboxViewState(seedParams, {
    incomingConnectorIds: Array.from(incomingConnectorIds),
    sendOnlyEmails: Array.from(sendOnlyEmails),
    preferredState: preferredInboxState,
  });

  if (!resolved.state) {
    return <Navigate to="/inbox" replace />;
  }

  return <Navigate to={toInboxPath(resolved.state)} replace />;
};

export default LegacyFolderRedirect;
