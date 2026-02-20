import { FastifyInstance } from 'fastify';
import { registerSyncManagementRoutes } from './syncManagementRoutes.js';
import { registerSyncPushRoutes } from './syncPushRoutes.js';
import { registerSyncEventsRoutes } from './syncEventsRoutes.js';

export const registerSyncRoutes = async (app: FastifyInstance) => {
  await registerSyncManagementRoutes(app);
  await registerSyncPushRoutes(app);
  await registerSyncEventsRoutes(app);
};
