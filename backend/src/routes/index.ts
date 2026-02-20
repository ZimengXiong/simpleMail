import { FastifyInstance } from 'fastify';
import { registerConnectorRoutes } from './connectors.js';
import { registerSyncRoutes } from './syncRoutes.js';
import { registerMessageRoutes } from './messages.js';

export const registerRoutes = async (app: FastifyInstance) => {
  await registerConnectorRoutes(app);
  await registerSyncRoutes(app);
  await registerMessageRoutes(app);
};
