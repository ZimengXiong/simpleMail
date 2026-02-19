import Fastify from 'fastify';
import { env } from './src/config/env.js';
import { registerRoutes } from './src/routes/index.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ResolvedUser } from './src/services/user.js';
import { createUser, getUserByToken } from './src/services/user.js';
import { resumeConfiguredIdleWatches } from './src/services/imap.js';

type AuthenticatedRequest = FastifyRequest & { user: ResolvedUser | null };

const server = Fastify({
  logger: env.nodeEnv === 'development',
});

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

if (env.nodeEnv === 'production' && !env.apiAdminToken) {
  throw new Error('API_ADMIN_TOKEN is required in production');
}

const rawWebhookPath = String(env.gmailPush.webhookPath || '').trim();
if (!rawWebhookPath.startsWith('/') || rawWebhookPath.includes('://')) {
  throw new Error('GMAIL_PUSH_WEBHOOK_PATH must be an absolute path');
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
  path === '/api/admin/users' || path.startsWith('/api/admin/users/');

type RouteRateLimitRule = {
  id: string;
  windowMs: number;
  max: number;
  match: (path: string) => boolean;
};

const routeRateLimitRules: RouteRateLimitRule[] = [
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
    id: 'oauth-authorize',
    windowMs: 60_000,
    max: 60,
    match: (path) => path === '/api/oauth/google/authorize',
  },
];

const routeRateLimitCounters = new Map<string, { resetAtMs: number; count: number }>();

const checkRateLimit = (ip: string, path: string) => {
  const matchedRule = routeRateLimitRules.find((rule) => rule.match(path));
  if (!matchedRule) {
    return null;
  }

  const key = `${matchedRule.id}:${ip}`;
  const nowMs = Date.now();
  const existing = routeRateLimitCounters.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
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

const extractUserToken = (request: FastifyRequest) => {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const userToken = request.headers['x-user-token'];
  const headerToken = Array.isArray(userToken) ? userToken[0] : userToken;
  if (headerToken) {
    return headerToken;
  }

  return undefined;
};

const bootstrapDevUser = async () => {
  if (env.nodeEnv !== 'development' || !env.bootstrapDevUser) {
    return;
  }

  if (!env.devUserToken) {
    return;
  }

  const user = await createUser({
    email: env.devUserEmail,
    name: env.devUserName,
    token: env.devUserToken,
  });

  if (user?.token) {
    console.log(`Bootstrapped dev user ${user.email} with prefix ${user.tokenPrefix}`);
  }
};

const ensureBootstrapDevUser = async (userToken: string) => {
  if (env.nodeEnv !== 'development' || !env.bootstrapDevUser || !env.devUserToken) {
    return null;
  }

  if (userToken !== env.devUserToken) {
    return null;
  }

  const user = await createUser({
    email: env.devUserEmail,
    name: env.devUserName,
    token: env.devUserToken,
  });

  if (user?.token) {
    console.log(`Recreated missing dev user ${user.email} with prefix ${user.tokenPrefix}`);
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    tokenPrefix: user.tokenPrefix,
  };
};

server.addHook('onRequest', async (request, reply) => {
  const requestPath = getRequestPathname(request.url);
  if (isPublicRoute(requestPath)) {
    return;
  }

  const retryAfter = checkRateLimit(request.ip, requestPath);
  if (retryAfter !== null) {
    reply.header('Retry-After', String(retryAfter));
    return reply.code(429).send({ error: 'too many requests' });
  }

  const headerValue = request.headers['x-api-key'];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const hasAdminToken = Boolean(env.apiAdminToken && headerToken === env.apiAdminToken);
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

  const userToken = extractUserToken(request);
  if (!userToken) {
    return reply.code(401).send({ error: 'missing user token' });
  }

  const user = (await getUserByToken(userToken)) ?? (await ensureBootstrapDevUser(userToken));
  if (!user) {
    return reply.code(401).send({ error: 'invalid user token' });
  }

  (request as AuthenticatedRequest).user = user;
});

server.addHook('onSend', async (_request, reply, payload) => {
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
await bootstrapDevUser();
void resumeConfiguredIdleWatches().catch((error) => {
  server.log.warn({ error }, 'failed to resume idle watchers');
});

const stop = async () => {
  await server.close();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await server.listen({ port: env.port, host: '0.0.0.0' });
console.log(`BetterMail API listening on ${env.port}`);
