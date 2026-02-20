import DOMPurify, { type Config } from 'dompurify';

const BASE_FORBID_TAGS = ['script', 'iframe', 'object', 'embed', 'meta', 'base', 'form', 'input', 'button', 'svg', 'math', 'link'];
const BASE_FORBID_ATTR = ['srcset', 'formaction', 'xlink:href'];

const EMAIL_SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [...BASE_FORBID_TAGS, 'style'],
  FORBID_ATTR: [...BASE_FORBID_ATTR, 'style'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  ALLOW_DATA_ATTR: false,
};

const EMAIL_SANITIZE_CONFIG_ALLOW_STYLE: Config = {
  ...EMAIL_SANITIZE_CONFIG,
  FORBID_TAGS: [...BASE_FORBID_TAGS],
  FORBID_ATTR: [...BASE_FORBID_ATTR],
};

export type SanitizedEmailHtmlResult = {
  html: string;
  hasBlockedContent: boolean;
  blockedTagNames: string[];
  blockedAttributeNames: string[];
};

type SanitizeOptions = {
  allowStyles?: boolean;
};

type RemovedSanitizerEntry = {
  element?: {
    nodeName?: string;
  };
  attribute?: {
    name?: string;
  } | string;
};

const hardenEmailLinks = (sanitizedHtml: string): string => {
  if (typeof window === 'undefined' || !sanitizedHtml) {
    return sanitizedHtml;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizedHtml, 'text/html');
  const anchors = doc.querySelectorAll('a[href]');
  anchors.forEach((anchor) => {
    anchor.setAttribute('target', '_blank');
    const existingRel = String(anchor.getAttribute('rel') ?? '')
      .split(/\s+/)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const rel = new Set(existingRel);
    rel.add('noopener');
    rel.add('noreferrer');
    anchor.setAttribute('rel', Array.from(rel).join(' '));
  });
  return doc.body.innerHTML;
};

const getRemovedItems = (): RemovedSanitizerEntry[] => {
  const maybePurify = DOMPurify as typeof DOMPurify & { removed?: RemovedSanitizerEntry[] };
  return Array.isArray(maybePurify.removed) ? maybePurify.removed : [];
};

const inferRemovedParts = (removedItems: RemovedSanitizerEntry[]) => {
  const blockedTags = new Set<string>();
  const blockedAttributes = new Set<string>();
  for (const item of removedItems) {
    const elementName = String(item?.element?.nodeName ?? '').toLowerCase().trim();
    if (elementName) {
      blockedTags.add(elementName);
    }
    const attributeRaw = typeof item.attribute === 'string'
      ? item.attribute
      : (item.attribute?.name ?? '');
    const attrName = String(attributeRaw).toLowerCase().trim();
    if (attrName) {
      blockedAttributes.add(attrName);
    }
  }
  return {
    blockedTagNames: Array.from(blockedTags).sort(),
    blockedAttributeNames: Array.from(blockedAttributes).sort(),
  };
};

export const sanitizeEmailHtmlWithReport = (
  value: string,
  options: SanitizeOptions = {},
): SanitizedEmailHtmlResult => {
  const config = options.allowStyles ? EMAIL_SANITIZE_CONFIG_ALLOW_STYLE : EMAIL_SANITIZE_CONFIG;
  const html = hardenEmailLinks(String(DOMPurify.sanitize(value, config)));
  const removedItems = getRemovedItems();
  const inferred = inferRemovedParts(removedItems);
  return {
    html,
    hasBlockedContent: removedItems.length > 0,
    blockedTagNames: inferred.blockedTagNames,
    blockedAttributeNames: inferred.blockedAttributeNames,
  };
};

export const sanitizeEmailHtml = (value: string): string =>
  sanitizeEmailHtmlWithReport(value).html;
