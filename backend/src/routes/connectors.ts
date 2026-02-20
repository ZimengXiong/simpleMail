import { FastifyInstance } from 'fastify';
import { registerConnectorCoreRoutes } from './connectors-core.js';
import { registerConnectorIdentityRoutes } from './connectors-identity.js';
import { registerConnectorMutatingRoutes } from './connectors-mutate.js';
import { registerConnectorCleanupRoutes } from './connectors-cleanup.js';
import { registerOAuthAuthorizeRoutes } from './connectors-oauth-authorize.js';
import { registerOAuthCallbackRoutes } from './connectors-oauth-callback.js';

export const registerConnectorRoutes = async (app: FastifyInstance) => {
  await registerConnectorCoreRoutes(app);
  await registerConnectorMutatingRoutes(app);
  await registerConnectorCleanupRoutes(app);
  await registerConnectorIdentityRoutes(app);
  await registerOAuthAuthorizeRoutes(app);
  await registerOAuthCallbackRoutes(app);
};
