/**
 * Pure utility functions used by the threading system.
 * Extracted from threading.ts so they can be unit-tested without a DB.
 */

export const GENERIC_SUBJECTS = new Set([
  'hi',
  'hello',
  'test',
  'ok',
  'thanks',
  'update',
  'question',
  'invoice',
  'receipt',
  'no subject',
  'notification',
  'alert',
  'reminder',
  'info',
  'fyi',
]);

export const normalizeSubject = (subject = ''): string => {
  return subject
    .replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, '')
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
};

export const subjectGenericKey = (subject = '') =>
  subject
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export const extractEmails = (header?: string | null): string[] => {
  const matches = (header ?? '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  return Array.from(new Set(matches.map((value) => value.toLowerCase())));
};

export const intersects = (left: string[], right: string[]) => {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
};

export const normalizeMessageId = (value?: string | null): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const stripped = trimmed.replace(/^<+|>+$/g, '').trim();
  return stripped ? stripped.toLowerCase() : null;
};

export const messageIdVariants = (value?: string | null): string[] => {
  const normalized = normalizeMessageId(value);
  if (!normalized) {
    return [];
  }
  return [normalized, `<${normalized}>`];
};

export const isSubjectTooGeneric = (
  normalizedSubject: string,
  hasExplicitThreadHeaders: boolean,
  hasReplyPrefix: boolean,
): boolean => {
  const genericKey = subjectGenericKey(normalizedSubject);
  return (
    !normalizedSubject
    || genericKey.length < 4
    || GENERIC_SUBJECTS.has(genericKey)
    || (!hasExplicitThreadHeaders && !hasReplyPrefix)
  );
};
