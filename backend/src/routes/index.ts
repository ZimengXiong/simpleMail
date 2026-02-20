import { FastifyInstance } from 'fastify';
import { registerConnectorRoutes } from './connectors.js';
import { registerSyncRoutes } from './syncRoutes.js';
import { registerMessageRoutes } from './messages.js';
import { env } from '../config/env.js';

export const registerRoutes = async (app: FastifyInstance) => {
  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/session', async (req, reply) => {
    const user = (req as any).user;
    if (!user?.id) {
      return reply.code(401).send({ error: 'missing user context' });
    }
    return {
      id: String(user.id),
      email: String(user.email ?? ''),
      name: String(user.name ?? ''),
    };
  });

  app.get('/api/access-control', async () => ({
    allowedEmails: [...env.oidc.allowedEmails],
    requiredSubject: env.oidc.requiredSubject || '',
    gmailPushEnabled: env.gmailPush.enabled,
  }));

  await registerConnectorRoutes(app);
  await registerSyncRoutes(app);
  await registerMessageRoutes(app);
};
