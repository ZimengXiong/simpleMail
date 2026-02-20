import { FastifyInstance } from 'fastify';
import { registerMessageDetailRoutes } from './messages-detail-routes.js';
import { registerMessageListRoutes } from './messages-list-routes.js';
import { registerMessageMutationRoutes } from './messages-mutation-routes.js';
import { registerMessageSearchRoutes } from './messages-search-routes.js';
import { registerMessageScanPushRoutes } from './messages-scanpush-routes.js';

export const registerMessageRoutes = async (app: FastifyInstance) => {
  await registerMessageListRoutes(app);
  await registerMessageSearchRoutes(app);
  await registerMessageDetailRoutes(app);
  await registerMessageMutationRoutes(app);
  await registerMessageScanPushRoutes(app);
};
