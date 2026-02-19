import Fastify from 'fastify';
import { env } from './src/config/env.js';
import { registerRoutes } from './src/routes/index.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ResolvedUser } from './src/services/user.js';
import { getUserByToken } from './src/services/user.js';

type AuthenticatedRequest = FastifyRequest & { user: ResolvedUser | null };

const server = Fastify({
  logger: env.nodeEnv === 'development',
});

if (env.nodeEnv === 'production' && !env.apiAdminToken) {
  throw new Error('API_ADMIN_TOKEN is required in production');
}

const isPublicRoute = (url: string) =>
  url === '/api/health' ||
  url.startsWith('/api/oauth/google/callback');

const isAdminRoute = (url: string) =>
  url === '/api/admin/users' || url.startsWith('/api/admin/users/');

const extractUserToken = (request: FastifyRequest) => {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const userToken = request.headers['x-user-token'];
  return Array.isArray(userToken) ? userToken[0] : userToken;
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

  const user = await getUserByToken(userToken);
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

const stop = async () => {
  await server.close();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await server.listen({ port: env.port, host: '0.0.0.0' });
console.log(`BetterMail API listening on ${env.port}`);
