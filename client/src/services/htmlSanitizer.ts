import DOMPurify, { type Config } from 'dompurify';

const EMAIL_SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'meta', 'base', 'form', 'input', 'button'],
};

export const sanitizeEmailHtml = (value: string): string =>
  String(DOMPurify.sanitize(value, EMAIL_SANITIZE_CONFIG));
