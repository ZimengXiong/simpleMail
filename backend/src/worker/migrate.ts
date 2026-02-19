import { runMigrations } from 'graphile-worker';
import { env } from '../config/env.js';

runMigrations({
  connectionString: env.databaseUrl,
}).then(() => {
  console.log('Graphile Worker migrations complete');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
