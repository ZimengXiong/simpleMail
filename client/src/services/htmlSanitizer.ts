import DOMPurify, { type Config } from 'dompurify';

const BASE_FORBID_TAGS = ['script', 'iframe', 'object', 'embed', 'meta', 'base', 'form', 'input', 'button', 'svg', 'math', 'link'];
const BASE_FORBID_ATTR = ['srcset', 'formaction', 'xlink:href'];

const EMAIL_SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [...BASE_FORBID_TAGS, 'style'],
  FORBID_ATTR: [...BASE_FORBID_ATTR, 'style'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
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

const getRemovedItems = (): any[] => {
  const maybePurify = DOMPurify as typeof DOMPurify & { removed?: any[] };
  return Array.isArray(maybePurify.removed) ? maybePurify.removed : [];
};

const inferRemovedParts = (removedItems: any[]) => {
  const blockedTags = new Set<string>();
  const blockedAttributes = new Set<string>();
  for (const item of removedItems) {
    const elementName = String(item?.element?.nodeName ?? '').toLowerCase().trim();
    if (elementName) {
      blockedTags.add(elementName);
    }
    const attrName = String(item?.attribute?.name ?? item?.attribute ?? '').toLowerCase().trim();
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
  const html = String(DOMPurify.sanitize(value, config));
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
