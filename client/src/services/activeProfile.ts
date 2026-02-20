import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { readPersistedInboxState, resolveInboxViewState } from './inboxStateMachine';

export const useActiveProfile = () => {
  const [searchParams] = useSearchParams();
  const preferredInboxState = useMemo(() => readPersistedInboxState(), []);

  const { data: connectors } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
    staleTime: 60_000,
  });

  const { data: outgoingConnectors } = useQuery({
    queryKey: ['connectors', 'outgoing'],
    queryFn: () => api.connectors.listOutgoing(),
    staleTime: 60_000,
  });

  const { data: identities } = useQuery({
    queryKey: ['identities'],
    queryFn: () => api.identities.list(),
    staleTime: 60_000,
  });

  const activeProfile = useMemo(() => {
    if (!connectors) return null;

    const connectorIds = connectors.map(c => c.id);
    const incomingEmails = new Set(connectors.map(c => String(c.emailAddress ?? '').trim().toLowerCase()).filter(Boolean));
    const sendOnlyEmails = new Set<string>();
    for (const outgoing of outgoingConnectors ?? []) {
      const email = String(outgoing.fromAddress ?? '').trim().toLowerCase();
      if (email && !incomingEmails.has(email)) sendOnlyEmails.add(email);
    }
    for (const identity of identities ?? []) {
      const email = String(identity.emailAddress ?? '').trim().toLowerCase();
      if (email && !incomingEmails.has(email)) sendOnlyEmails.add(email);
    }

    const resolved = resolveInboxViewState(searchParams, {
      incomingConnectorIds: connectorIds,
      sendOnlyEmails: Array.from(sendOnlyEmails),
      preferredState: preferredInboxState,
    });

    const state = resolved.state;
    if (!state) return null;
    const profile = state.profile;

    if (profile.kind === 'incoming') {
      const conn = connectors.find(c => c.id === profile.connectorId);
      return conn ? { name: conn.name || conn.emailAddress, email: conn.emailAddress, kind: 'incoming' as const } : null;
    } else {
      const email = profile.sendEmail;
      const id = identities?.find(i => i.emailAddress.toLowerCase() === email.toLowerCase());
      return { name: id?.displayName || email, email, kind: 'send-only' as const };
    }
  }, [connectors, outgoingConnectors, identities, searchParams, preferredInboxState]);

  return activeProfile;
};
