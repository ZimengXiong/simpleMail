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

if (env.nodeEnv === 'production' && !env.apiAdminToken) {
  throw new Error('API_ADMIN_TOKEN is required in production');
}

const isPublicRoute = (url: string) =>
  url === '/api/health' ||
  url.startsWith(env.gmailPush.webhookPath) ||
  url.startsWith('/api/oauth/google/callback');

const isAdminRoute = (url: string) =>
  url === '/api/admin/users' || url.startsWith('/api/admin/users/');

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

  const rawUrl = request.raw.url ?? request.url;
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex >= 0) {
    const search = rawUrl.slice(queryIndex + 1);
    const params = new URLSearchParams(search);
    const queryToken = params.get('token') || params.get('userToken');
    if (queryToken) {
      return queryToken;
    }
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
  const requestUrl = request.url;
  if (isPublicRoute(requestUrl)) {
    return;
  }

  const headerValue = request.headers['x-api-key'];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const hasAdminToken = Boolean(env.apiAdminToken && headerToken === env.apiAdminToken);
  const isAdminRequest = isAdminRoute(requestUrl);

  if (isAdminRequest) {
    request.log.info({ path: requestUrl, hasAdminToken }, 'admin route requested');
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

server.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
  request.log.error(error);
  const typedError = error as FastifyError;
  const statusCode = typedError.statusCode ?? 500;
  const message = error instanceof Error ? error.message : 'internal server error';
  reply.code(typeof statusCode === 'number' ? statusCode : 500).send({ error: message });
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
