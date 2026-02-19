import type { MessageRecord } from '../types/index';

type ThreadableMessage = Pick<MessageRecord, 'id' | 'messageId' | 'inReplyTo' | 'referencesHeader' | 'receivedAt'>;

type MessageMeta<T extends ThreadableMessage> = {
  message: T;
  index: number;
  timestamp: number;
};

export type OrderedThreadNode<T extends ThreadableMessage> = {
  message: T;
  parentId: string | null;
  depth: number;
};

const toTimestamp = (value: string | null | undefined) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const normalizeMessageIdToken = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const angleMatch = trimmed.match(/<([^>\s]+)>/);
  const token = angleMatch?.[1] ?? trimmed.split(/\s+/)[0]?.replace(/[<>]/g, '');
  if (!token) return null;

  const normalized = token.replace(/^<+|>+$/g, '').trim().toLowerCase();
  return normalized || null;
};

const extractMessageIdTokens = (value: string | null | undefined): string[] => {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  const angleTokens = trimmed.match(/<[^>\s]+>/g) ?? [];
  const candidates = angleTokens.length > 0 ? angleTokens : trimmed.split(/\s+/);

  const dedupe = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeMessageIdToken(candidate);
    if (normalized) {
      dedupe.add(normalized);
    }
  }

  return Array.from(dedupe);
};

export const normalizeMessageIdHeader = (value: string | null | undefined): string | null => {
  const normalized = normalizeMessageIdToken(value);
  return normalized ? `<${normalized}>` : null;
};

export const buildReplyReferencesHeader = (
  referencesHeader: string | null | undefined,
  messageId: string | null | undefined,
): string | undefined => {
  const tokens = extractMessageIdTokens(referencesHeader);
  const current = normalizeMessageIdToken(messageId);
  if (current) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return undefined;
  }

  const dedupe = Array.from(new Set(tokens));
  return dedupe.map((token) => `<${token}>`).join(' ');
};

const chronologicalComparator = <T extends ThreadableMessage>(left: MessageMeta<T>, right: MessageMeta<T>) => {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return left.index - right.index;
};

const pickBestParentId = <T extends ThreadableMessage>(
  current: MessageMeta<T>,
  candidateIds: string[] | undefined,
  idToMeta: Map<string, MessageMeta<T>>,
): string | null => {
  if (!candidateIds || candidateIds.length === 0) {
    return null;
  }

  const candidates = candidateIds
    .filter((candidateId) => candidateId !== current.message.id)
    .map((candidateId) => idToMeta.get(candidateId))
    .filter((meta): meta is MessageMeta<T> => Boolean(meta));

  if (candidates.length === 0) {
    return null;
  }

  const notAfterCurrent = candidates.filter((candidate) => candidate.timestamp <= current.timestamp);
  const pool = notAfterCurrent.length > 0 ? notAfterCurrent : candidates;
  pool.sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return right.timestamp - left.timestamp;
    }
    return right.index - left.index;
  });

  return pool[0]?.message.id ?? null;
};

const createsCycle = (id: string, parentId: string, parentById: Map<string, string | null>) => {
  const seen = new Set<string>([id]);
  let cursor: string | null = parentId;
  while (cursor) {
    if (seen.has(cursor)) {
      return true;
    }
    seen.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return false;
};

export const orderThreadMessages = <T extends ThreadableMessage>(messages: T[]): OrderedThreadNode<T>[] => {
  if (messages.length === 0) {
    return [];
  }

  const metas = messages.map((message, index) => ({
    message,
    index,
    timestamp: toTimestamp(message.receivedAt),
  }));
  const idToMeta = new Map(metas.map((meta) => [meta.message.id, meta]));

  const messageIdToRowIds = new Map<string, string[]>();
  for (const meta of metas) {
    const normalizedMessageId = normalizeMessageIdToken(meta.message.messageId);
    if (!normalizedMessageId) {
      continue;
    }
    const existing = messageIdToRowIds.get(normalizedMessageId) ?? [];
    existing.push(meta.message.id);
    messageIdToRowIds.set(normalizedMessageId, existing);
  }

  const parentById = new Map<string, string | null>();
  const metasByChronologicalOrder = [...metas].sort(chronologicalComparator);

  for (const meta of metasByChronologicalOrder) {
    const referenceTokens = extractMessageIdTokens(meta.message.referencesHeader);
    let parentId: string | null = null;

    for (let idx = referenceTokens.length - 1; idx >= 0 && !parentId; idx -= 1) {
      parentId = pickBestParentId(meta, messageIdToRowIds.get(referenceTokens[idx]), idToMeta);
    }

    if (!parentId) {
      const inReplyToToken = normalizeMessageIdToken(meta.message.inReplyTo);
      if (inReplyToToken) {
        parentId = pickBestParentId(meta, messageIdToRowIds.get(inReplyToToken), idToMeta);
      }
    }

    parentById.set(meta.message.id, parentId);
  }

  for (const meta of metasByChronologicalOrder) {
    const parentId = parentById.get(meta.message.id);
    if (!parentId) {
      continue;
    }
    if (createsCycle(meta.message.id, parentId, parentById)) {
      parentById.set(meta.message.id, null);
    }
  }

  const childrenById = new Map<string, MessageMeta<T>[]>();
  for (const meta of metas) {
    childrenById.set(meta.message.id, []);
  }

  for (const meta of metas) {
    const parentId = parentById.get(meta.message.id);
    if (!parentId) {
      continue;
    }
    const siblings = childrenById.get(parentId);
    if (siblings) {
      siblings.push(meta);
    }
  }

  for (const children of childrenById.values()) {
    children.sort(chronologicalComparator);
  }

  const roots = metas
    .filter((meta) => !parentById.get(meta.message.id))
    .sort(chronologicalComparator);

  const ordered: OrderedThreadNode<T>[] = [];
  const visited = new Set<string>();

  const visit = (meta: MessageMeta<T>, depth: number) => {
    if (visited.has(meta.message.id)) {
      return;
    }
    visited.add(meta.message.id);
    ordered.push({
      message: meta.message,
      parentId: parentById.get(meta.message.id) ?? null,
      depth,
    });

    const children = childrenById.get(meta.message.id) ?? [];
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }

  for (const meta of metasByChronologicalOrder) {
    if (!visited.has(meta.message.id)) {
      visit(meta, 0);
    }
  }

  return ordered;
};
