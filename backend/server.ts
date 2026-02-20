import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { env } from './src/config/env.js';
import { registerRoutes } from './src/routes/index.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ResolvedUser } from './src/services/user.js';
import { upsertUserFromOidc } from './src/services/user.js';
import { resumeConfiguredIdleWatches } from './src/services/imap.js';
import { verifyOidcAccessToken } from './src/services/oidc.js';

type AuthenticatedRequest = FastifyRequest & { user: ResolvedUser | null };

const server = Fastify({
  logger: env.nodeEnv === 'development',
  disableRequestLogging: true,
});

const secureTokenEquals = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeRoutePath = (value: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '/';
  }
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (prefixed === '/') {
    return '/';
  }
  return prefixed.replace(/\/+$/, '');
};

const getRequestPathname = (url: string) => {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return String(url || '/').split('?')[0] || '/';
  }
};

const isSecureExternalUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') {
      return true;
    }
    if (parsed.protocol !== 'http:') {
      return false;
    }
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  } catch {
    return false;
  }
};

const isPrivateIpv4 = (hostname: string) => {
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  if (octets[0] === 10) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  return false;
};

const isPrivateOrLocalHostname = (hostname: string) => {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized === 'host.docker.internal') return true;
  if (normalized.endsWith('.local') || normalized.endsWith('.lan') || normalized.endsWith('.internal')) return true;

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return false;
};

const allowsInsecureOidcUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' && isPrivateOrLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
};

const looksWeakSharedCredential = (value: string) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 16) return true;
  const blocked = new Set([
    'seaweed_admin',
    'seaweed_admin_secret',
    'simplemail',
    'change-me',
    'changeme',
    'password',
    'secret',
    'admin',
  ]);
  return blocked.has(normalized);
};

const isSafeAbsolutePath = (value: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return false;
  }
  if (trimmed.includes('://') || trimmed.includes('\\')) {
    return false;
  }
  try {
    const parsed = new URL(trimmed, 'http://localhost');
    return parsed.pathname === trimmed && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
};

if (env.nodeEnv === 'production' && !env.apiAdminToken) {
  throw new Error('API_ADMIN_TOKEN is required in production');
}

if (env.apiAdminToken && env.apiAdminToken.length < 24) {
  throw new Error('API_ADMIN_TOKEN must be at least 24 characters');
}

if (env.nodeEnv === 'production' && env.allowAdminUserBootstrap) {
  throw new Error('ALLOW_ADMIN_USER_BOOTSTRAP must be false in production');
}

const rawWebhookPath = String(env.gmailPush.webhookPath || '').trim();
if (!isSafeAbsolutePath(rawWebhookPath)) {
  throw new Error('GMAIL_PUSH_WEBHOOK_PATH must be an absolute path');
}

const rawOauthCallbackPath = String(env.oauthCallbackPath || '').trim();
if (!isSafeAbsolutePath(rawOauthCallbackPath)) {
  throw new Error('OAUTH_CALLBACK_PATH must be an absolute path');
}

if (env.nodeEnv === 'production') {
  if (!isSecureExternalUrl(env.appBaseUrl)) {
    throw new Error('APP_BASE_URL must use HTTPS in production');
  }
  if (!isSecureExternalUrl(env.frontendBaseUrl)) {
    throw new Error('FRONTEND_BASE_URL must use HTTPS in production');
  }
  if (!isSecureExternalUrl(env.googleRedirectUri)) {
    throw new Error('GOOGLE_REDIRECT_URI must use HTTPS in production');
  }
  if (!isSecureExternalUrl(env.oidc.issuerUrl)) {
    if (!env.oidc.allowInsecureHttp || !allowsInsecureOidcUrl(env.oidc.issuerUrl)) {
      throw new Error('OIDC_ISSUER_URL must use HTTPS in production unless OIDC_ALLOW_INSECURE_HTTP=true and host is local/private');
    }
  }
  if (env.oidc.jwksUri && !isSecureExternalUrl(env.oidc.jwksUri)) {
    if (!env.oidc.allowInsecureHttp || !allowsInsecureOidcUrl(env.oidc.jwksUri)) {
      throw new Error('OIDC_JWKS_URI must use HTTPS in production unless OIDC_ALLOW_INSECURE_HTTP=true and host is local/private');
    }
  }
  if (looksWeakSharedCredential(env.seaweed.accessKeyId)) {
    throw new Error('SEAWEED_ACCESS_KEY_ID is too weak for production');
  }
  if (looksWeakSharedCredential(env.seaweed.secretAccessKey)) {
    throw new Error('SEAWEED_SECRET_ACCESS_KEY is too weak for production');
  }
}

if (env.oidc.allowedEmails.length !== 1) {
  throw new Error('OIDC_ALLOWED_EMAILS must contain exactly one email');
}

if (env.gmailPush.enabled && !env.gmailPush.pushServiceAccountEmail) {
  throw new Error('GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL is required when GMAIL_PUSH_ENABLED=true');
}

const gmailWebhookPath = normalizeRoutePath(env.gmailPush.webhookPath);
const isPublicRoute = (path: string) => {
  const normalizedPath = normalizeRoutePath(path);
  return (
    normalizedPath === '/api/health'
    || normalizedPath === gmailWebhookPath
    || normalizedPath === '/api/oauth/google/callback'
  );
};

const isAdminRoute = (path: string) =>
  env.allowAdminUserBootstrap
  && (path === '/api/admin/users' || path.startsWith('/api/admin/users/'));

type RouteRateLimitRule = {
  id: string;
  windowMs: number;
  max: number;
  match: (path: string) => boolean;
};

const routeRateLimitRules: RouteRateLimitRule[] = [
  {
    id: 'health',
    windowMs: 60_000,
    max: 120,
    match: (path) => path === '/api/health',
  },
  {
    id: 'oauth-callback',
    windowMs: 60_000,
    max: 120,
    match: (path) => path === '/api/oauth/google/callback',
  },
  {
    id: 'gmail-push-webhook',
    windowMs: 60_000,
    max: 600,
    match: (path) => path === gmailWebhookPath,
  },
  {
    id: 'admin',
    windowMs: 60_000,
    max: 30,
    match: (path) => path.startsWith('/api/admin/'),
  },
  {
    id: 'connector-test',
    windowMs: 60_000,
    max: 40,
    match: (path) => /^\/api\/connectors\/outgoing\/[^/]+\/test$/.test(path),
  },
  {
    id: 'connector-mailboxes',
    windowMs: 60_000,
    max: 40,
    match: (path) => /^\/api\/connectors\/[^/]+\/mailboxes$/.test(path),
  },
  {
    id: 'oauth-authorize',
    windowMs: 60_000,
    max: 60,
    match: (path) => path === '/api/oauth/google/authorize',
  },
  {
    id: 'messages-send',
    windowMs: 60_000,
    max: 45,
    match: (path) => path === '/api/messages/send',
  },
  {
    id: 'attachments',
    windowMs: 60_000,
    max: 180,
    match: (path) =>
      /^\/api\/attachments\/[^/]+\/(?:download|view)$/.test(path)
      || /^\/api\/messages\/[^/]+\/raw$/.test(path),
  },
  {
    id: 'attachments-scan',
    windowMs: 60_000,
    max: 60,
    match: (path) => path === '/api/attachments/scan',
  },
  {
    id: 'sync-watch',
    windowMs: 60_000,
    max: 90,
    match: (path) => /^\/api\/sync\/[^/]+\/watch(?:\/stop)?$/.test(path),
  },
  {
    id: 'events-stream',
    windowMs: 60_000,
    max: 30,
    match: (path) => path === '/api/events/stream',
  },
];

const routeRateLimitCounters = new Map<string, { resetAtMs: number; count: number }>();
const ROUTE_RATE_LIMIT_SWEEP_INTERVAL_MS = 60_000;
const ROUTE_RATE_LIMIT_MAX_COUNTERS = 20_000;
let lastRateLimitSweepAtMs = 0;

const sweepRouteRateLimitCounters = (nowMs: number) => {
  if (
    routeRateLimitCounters.size === 0
    || (
      routeRateLimitCounters.size < ROUTE_RATE_LIMIT_MAX_COUNTERS
      && nowMs - lastRateLimitSweepAtMs < ROUTE_RATE_LIMIT_SWEEP_INTERVAL_MS
    )
  ) {
    return;
  }

  lastRateLimitSweepAtMs = nowMs;
  for (const [key, entry] of routeRateLimitCounters.entries()) {
    if (entry.resetAtMs <= nowMs) {
      routeRateLimitCounters.delete(key);
    }
  }

  if (routeRateLimitCounters.size <= ROUTE_RATE_LIMIT_MAX_COUNTERS) {
    return;
  }

  const overflow = routeRateLimitCounters.size - ROUTE_RATE_LIMIT_MAX_COUNTERS;
  let removed = 0;
  for (const key of routeRateLimitCounters.keys()) {
    routeRateLimitCounters.delete(key);
    removed += 1;
    if (removed >= overflow) {
      break;
    }
  }
};

const checkRateLimit = (ip: string, path: string) => {
  const matchedRule = routeRateLimitRules.find((rule) => rule.match(path));
  if (!matchedRule) {
    return null;
  }

  const nowMs = Date.now();
  sweepRouteRateLimitCounters(nowMs);

  const key = `${matchedRule.id}:${ip}`;
  const existing = routeRateLimitCounters.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    if (!existing && routeRateLimitCounters.size >= ROUTE_RATE_LIMIT_MAX_COUNTERS) {
      const oldestKey = routeRateLimitCounters.keys().next().value;
      if (oldestKey) {
        routeRateLimitCounters.delete(oldestKey);
      }
    }
    routeRateLimitCounters.set(key, {
      resetAtMs: nowMs + matchedRule.windowMs,
      count: 1,
    });
    return null;
  }

  if (existing.count >= matchedRule.max) {
    return Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
  }
  existing.count += 1;
  return null;
};

const MAX_ACCESS_TOKEN_CHARS = 16_384;

const normalizeTokenCandidate = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ACCESS_TOKEN_CHARS) {
    return undefined;
  }
  return normalized;
};

const extractAccessToken = (request: FastifyRequest) => {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = normalizeTokenCandidate(authHeader.slice(7));
    if (token) {
      return token;
    }
  }

  return undefined;
};

server.addHook('onRequest', async (request, reply) => {
  const requestPath = getRequestPathname(request.url);
  const retryAfter = checkRateLimit(request.ip, requestPath);
  if (retryAfter !== null) {
    reply.header('Retry-After', String(retryAfter));
    return reply.code(429).send({ error: 'too many requests' });
  }

  if (isPublicRoute(requestPath)) {
    return;
  }

  if (!env.allowAdminUserBootstrap && requestPath.startsWith('/api/admin/')) {
    return reply.code(404).send({ error: 'not found' });
  }

  const headerValue = request.headers['x-api-key'];
  const headerToken = normalizeTokenCandidate(Array.isArray(headerValue) ? headerValue[0] : headerValue);
  const hasAdminToken = Boolean(
    env.apiAdminToken
    && headerToken
    && secureTokenEquals(headerToken, env.apiAdminToken),
  );
  const isAdminRequest = isAdminRoute(requestPath);

  if (isAdminRequest) {
    request.log.info({ path: requestPath, hasAdminToken }, 'admin route requested');
    if (env.apiAdminToken && !hasAdminToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (env.apiAdminToken && hasAdminToken) {
      return;
    }
    return reply.code(401).send({ error: 'admin token missing' });
  }

  const accessToken = extractAccessToken(request);
  if (!accessToken) {
    return reply.code(401).send({ error: 'missing access token' });
  }

  let identity: Awaited<ReturnType<typeof verifyOidcAccessToken>>;
  try {
    identity = await verifyOidcAccessToken(accessToken);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown verification error';
    request.log.warn({ path: requestPath, reason }, 'OIDC token verification failed');
    const message = env.nodeEnv === 'development'
      ? `invalid access token: ${reason}`
      : 'invalid access token';
    return reply.code(401).send({ error: message });
  }

  if (!env.oidc.allowedEmails.includes(identity.email)) {
    return reply.code(403).send({ error: 'authenticated user is not allowed' });
  }

  if (env.oidc.requiredSubject && identity.subject !== env.oidc.requiredSubject) {
    return reply.code(403).send({ error: 'authenticated subject is not allowed' });
  }

  const user = await upsertUserFromOidc({
    email: identity.email,
    name: identity.name,
    subject: identity.subject,
  });
  (request as AuthenticatedRequest).user = user;
});

server.addHook('onSend', async (_request, reply, payload) => {
  if (!reply.hasHeader('Cache-Control')) {
    reply.header('Cache-Control', 'no-store');
  }
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Permitted-Cross-Domain-Policies', 'none');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (!reply.hasHeader('Content-Security-Policy')) {
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  }
  if (env.nodeEnv === 'production') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return payload;
});

server.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
  request.log.error(error);
  const typedError = error as FastifyError;
  const statusCode = typedError.statusCode ?? 500;
  const resolvedStatus = typeof statusCode === 'number' ? statusCode : 500;
  const exposeMessage = resolvedStatus >= 400 && resolvedStatus < 500;
  const message = exposeMessage
    ? (error instanceof Error ? error.message : 'request failed')
    : 'internal server error';
  reply.code(resolvedStatus).send({ error: message });
});

await registerRoutes(server);
void resumeConfiguredIdleWatches().catch((error) => {
  server.log.warn({ error }, 'failed to resume idle watchers');
});

const stop = async () => {
  await server.close();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await server.listen({ port: env.port, host: '0.0.0.0' });
console.log(`simpleMail API listening on ${env.port}`);
