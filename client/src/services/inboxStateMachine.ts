import { readJson, readStorageString, writeStorageString } from './storage';

type InboxStateStorageShape = {
  profile: {
    kind: 'incoming';
    connectorId: string;
  } | {
    kind: 'send-only';
    sendEmail: string;
  };
  folder: string;
  query: string;
  page: number;
  threadId: string | null;
};

export type InboxProfileState = InboxStateStorageShape['profile'];
export type InboxViewState = InboxStateStorageShape;

export type InboxStateEvent =
  | { type: 'select-profile'; profile: InboxProfileState }
  | { type: 'select-folder'; folder: string }
  | { type: 'set-query'; query: string }
  | { type: 'set-page'; page: number }
  | { type: 'open-thread'; threadId: string }
  | { type: 'close-thread' };

export type InboxStateResolverOptions = {
  incomingConnectorIds: string[];
  sendOnlyEmails: string[];
  preferredState?: InboxViewState | null;
};

export type ResolvedInboxViewState = {
  state: InboxViewState | null;
  searchParams: URLSearchParams;
  changed: boolean;
};

const STORAGE_KEY = 'SIMPLEMAIL_INBOX_VIEW_STATE_V1';
const KNOWN_PARAM_KEYS = ['connectorId', 'profile', 'sendEmail', 'folder', 'q', 'page', 'threadId'] as const;

const normalizeConnectorId = (value: unknown): string => String(value ?? '').trim();
const normalizeSendEmail = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const normalizeFolder = (value: unknown): string => String(value ?? '').trim();
const normalizeQuery = (value: unknown): string => String(value ?? '').trim();
const normalizeThreadId = (value: unknown): string | null => {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
};

const sanitizePage = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.floor(parsed);
};

const normalizeFolderForProfile = (profile: InboxProfileState, folder: string | null | undefined): string => {
  if (profile.kind === 'send-only') {
    const token = String(folder ?? '').trim().toUpperCase();
    return token === 'SENT' ? 'SENT' : 'OUTBOX';
  }

  const normalized = String(folder ?? '').trim();
  return normalized || 'INBOX';
};

const hasInboxStateParams = (searchParams: URLSearchParams): boolean =>
  KNOWN_PARAM_KEYS.some((key) => searchParams.has(key));

const isProfileAvailable = (
  profile: InboxProfileState,
  options: InboxStateResolverOptions,
): boolean => {
  if (profile.kind === 'incoming') {
    return options.incomingConnectorIds.length === 0 || options.incomingConnectorIds.includes(profile.connectorId);
  }
  return options.sendOnlyEmails.length === 0 || options.sendOnlyEmails.includes(profile.sendEmail);
};

const pickFallbackProfile = (options: InboxStateResolverOptions): InboxProfileState | null => {
  if (options.preferredState && isProfileAvailable(options.preferredState.profile, options)) {
    return options.preferredState.profile;
  }
  const firstIncoming = options.incomingConnectorIds[0];
  if (firstIncoming) {
    return {
      kind: 'incoming',
      connectorId: firstIncoming,
    };
  }
  const firstSendOnly = options.sendOnlyEmails[0];
  if (firstSendOnly) {
    return {
      kind: 'send-only',
      sendEmail: firstSendOnly,
    };
  }
  return null;
};

const parseProfileFromSearch = (searchParams: URLSearchParams): InboxProfileState | null => {
  const profileToken = String(searchParams.get('profile') ?? '').trim().toLowerCase();
  if (profileToken === 'send-only') {
    const sendEmail = normalizeSendEmail(searchParams.get('sendEmail'));
    if (sendEmail) {
      return {
        kind: 'send-only',
        sendEmail,
      };
    }
    return null;
  }

  const connectorId = normalizeConnectorId(searchParams.get('connectorId'));
  if (connectorId) {
    return {
      kind: 'incoming',
      connectorId,
    };
  }
  return null;
};

const normalizeStateShape = (value: unknown): InboxViewState | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<InboxViewState>;
  const profile = candidate.profile;
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  if ((profile as InboxProfileState).kind === 'incoming') {
    const connectorId = normalizeConnectorId((profile as { connectorId?: string }).connectorId);
    if (!connectorId) {
      return null;
    }
    return {
      profile: {
        kind: 'incoming',
        connectorId,
      },
      folder: normalizeFolder((candidate as { folder?: string }).folder) || 'INBOX',
      query: normalizeQuery((candidate as { query?: string }).query),
      page: sanitizePage((candidate as { page?: number }).page),
      threadId: normalizeThreadId((candidate as { threadId?: string | null }).threadId),
    };
  }

  if ((profile as InboxProfileState).kind === 'send-only') {
    const sendEmail = normalizeSendEmail((profile as { sendEmail?: string }).sendEmail);
    if (!sendEmail) {
      return null;
    }
    return {
      profile: {
        kind: 'send-only',
        sendEmail,
      },
      folder: normalizeFolderForProfile({ kind: 'send-only', sendEmail }, normalizeFolder((candidate as { folder?: string }).folder)),
      query: normalizeQuery((candidate as { query?: string }).query),
      page: sanitizePage((candidate as { page?: number }).page),
      threadId: normalizeThreadId((candidate as { threadId?: string | null }).threadId),
    };
  }

  return null;
};

export const readPersistedInboxState = (): InboxViewState | null => {
  if (!readStorageString(STORAGE_KEY)) {
    return null;
  }
  return normalizeStateShape(readJson<unknown>(STORAGE_KEY, null));
};

export const persistInboxState = (state: InboxViewState | null): void => {
  if (!state) {
    return;
  }
  writeStorageString(STORAGE_KEY, JSON.stringify(state));
};

export const buildInboxSearchParams = (base: URLSearchParams, state: InboxViewState): URLSearchParams => {
  const next = new URLSearchParams(base);
  if (state.profile.kind === 'incoming') {
    next.set('connectorId', state.profile.connectorId);
    next.delete('profile');
    next.delete('sendEmail');
  } else {
    next.set('profile', 'send-only');
    next.set('sendEmail', state.profile.sendEmail);
    next.delete('connectorId');
  }
  next.set('folder', normalizeFolderForProfile(state.profile, state.folder));
  const query = normalizeQuery(state.query);
  if (query) {
    next.set('q', query);
  } else {
    next.delete('q');
  }
  next.set('page', String(sanitizePage(state.page)));
  if (state.threadId) {
    next.set('threadId', state.threadId);
  } else {
    next.delete('threadId');
  }
  return next;
};

export const toInboxPath = (state: InboxViewState): string =>
  `/inbox?${buildInboxSearchParams(new URLSearchParams(), state).toString()}`;

export const reduceInboxState = (state: InboxViewState, event: InboxStateEvent): InboxViewState => {
  switch (event.type) {
    case 'select-profile': {
      return {
        profile: event.profile,
        folder: normalizeFolderForProfile(event.profile, null),
        query: state.query,
        page: 1,
        threadId: null,
      };
    }
    case 'select-folder': {
      return {
        ...state,
        folder: normalizeFolderForProfile(state.profile, event.folder),
        page: 1,
        threadId: null,
      };
    }
    case 'set-query': {
      return {
        ...state,
        query: normalizeQuery(event.query),
        page: 1,
        threadId: null,
      };
    }
    case 'set-page': {
      return {
        ...state,
        page: sanitizePage(event.page),
        threadId: null,
      };
    }
    case 'open-thread': {
      return {
        ...state,
        threadId: normalizeThreadId(event.threadId),
      };
    }
    case 'close-thread': {
      return {
        ...state,
        threadId: null,
      };
    }
    default: {
      return state;
    }
  }
};

export const resolveInboxViewState = (
  searchParams: URLSearchParams,
  options: InboxStateResolverOptions,
): ResolvedInboxViewState => {
  const incomingConnectorIds = Array.from(new Set(
    options.incomingConnectorIds.map((connectorId) => normalizeConnectorId(connectorId)).filter(Boolean),
  ));
  const sendOnlyEmails = Array.from(new Set(
    options.sendOnlyEmails.map((email) => normalizeSendEmail(email)).filter(Boolean),
  ));
  const normalizedOptions: InboxStateResolverOptions = {
    incomingConnectorIds,
    sendOnlyEmails,
    preferredState: options.preferredState ?? null,
  };

  const hasAnyKnownParam = hasInboxStateParams(searchParams);
  const preferredState = normalizedOptions.preferredState;
  const canUsePreferredState = Boolean(
    preferredState
    && normalizeStateShape(preferredState)
    && isProfileAvailable(preferredState.profile, normalizedOptions),
  );

  const parsedProfile = parseProfileFromSearch(searchParams);
  const resolvedProfile = parsedProfile && isProfileAvailable(parsedProfile, normalizedOptions)
    ? parsedProfile
    : (
      !hasAnyKnownParam && canUsePreferredState
        ? (preferredState as InboxViewState).profile
        : pickFallbackProfile(normalizedOptions)
    );

  if (!resolvedProfile) {
    return {
      state: null,
      searchParams: new URLSearchParams(searchParams),
      changed: false,
    };
  }

  const hasExplicitQuery = searchParams.has('q');
  const hasExplicitPage = searchParams.has('page');
  const hasExplicitThreadId = searchParams.has('threadId');
  const hasExplicitFolder = searchParams.has('folder');
  const fallbackState = !hasAnyKnownParam && canUsePreferredState
    ? normalizeStateShape(preferredState)
    : null;

  const nextState: InboxViewState = {
    profile: resolvedProfile,
    folder: normalizeFolderForProfile(
      resolvedProfile,
      hasExplicitFolder
        ? normalizeFolder(searchParams.get('folder'))
        : (fallbackState?.folder ?? null),
    ),
    query: hasExplicitQuery
      ? normalizeQuery(searchParams.get('q'))
      : (fallbackState?.query ?? ''),
    page: hasExplicitPage
      ? sanitizePage(searchParams.get('page'))
      : (fallbackState?.page ?? 1),
    threadId: hasExplicitThreadId
      ? normalizeThreadId(searchParams.get('threadId'))
      : (fallbackState?.threadId ?? null),
  };

  const canonicalSearchParams = buildInboxSearchParams(searchParams, nextState);
  return {
    state: nextState,
    searchParams: canonicalSearchParams,
    changed: canonicalSearchParams.toString() !== searchParams.toString(),
  };
};
