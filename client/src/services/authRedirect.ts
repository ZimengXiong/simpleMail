const DEFAULT_NEXT_PATH = '/inbox';

const readLocationPart = (key: 'href' | 'origin' | 'pathname' | 'search' | 'hash'): string => {
  const value = (window.location as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
};

const readOrigin = (): string => {
  const directOrigin = readLocationPart('origin');
  if (directOrigin) {
    return directOrigin;
  }
  const href = readLocationPart('href');
  if (!href) {
    return 'http://localhost';
  }
  try {
    const parsed = new URL(href, 'http://localhost');
    return parsed.origin;
  } catch {
    return 'http://localhost';
  }
};

const decodeUriComponentSafely = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeSameOriginPath = (value: string): string => {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.startsWith('//')) {
    return DEFAULT_NEXT_PATH;
  }
  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  try {
    const appOrigin = readOrigin();
    const parsed = new URL(trimmed, appOrigin);
    if (parsed.origin !== appOrigin) {
      return DEFAULT_NEXT_PATH;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || DEFAULT_NEXT_PATH;
  } catch {
    return DEFAULT_NEXT_PATH;
  }
};

export const resolveSafeNextPath = (
  nextCandidate: string | null | undefined,
  fallbackPath = DEFAULT_NEXT_PATH,
): string => {
  const decoded = decodeUriComponentSafely(String(nextCandidate || ''));
  const normalized = normalizeSameOriginPath(decoded || fallbackPath);
  if (normalized === '/login' || normalized.startsWith('/login?')) {
    return fallbackPath;
  }
  return normalized;
};

const currentRelativePath = (): string =>
  (() => {
    const pathname = readLocationPart('pathname');
    const search = readLocationPart('search');
    const hash = readLocationPart('hash');
    if (pathname || search || hash) {
      return `${pathname}${search}${hash}`;
    }
    const href = readLocationPart('href');
    if (!href) {
      return '';
    }
    try {
      const parsed = new URL(href, readOrigin());
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return '';
    }
  })();

export const buildLoginPath = (nextCandidate?: string | null): string => {
  const pathname = readLocationPart('pathname');
  const search = readLocationPart('search');
  const defaultCandidate = pathname.startsWith('/login')
    ? new URLSearchParams(search).get('next')
    : currentRelativePath();
  const rawCandidate = nextCandidate ?? defaultCandidate;
  const hasCandidate = Boolean(String(rawCandidate || '').trim());
  if (!hasCandidate) {
    return '/login';
  }
  const nextPath = resolveSafeNextPath(rawCandidate);
  return `/login?next=${encodeURIComponent(nextPath)}`;
};

export const redirectToLogin = (nextCandidate?: string | null): void => {
  const loginPath = buildLoginPath(nextCandidate);
  const currentPath = `${readLocationPart('pathname')}${readLocationPart('search')}`;
  if (currentPath === loginPath) {
    return;
  }
  if (typeof window.location.assign === 'function') {
    window.location.assign(loginPath);
    return;
  }
  (window.location as unknown as { href: string }).href = loginPath;
};

export const toAbsoluteAppUrl = (path: string): string =>
  new URL(resolveSafeNextPath(path), readOrigin()).toString();
