import { runMigrations } from 'graphile-worker';
import { env } from '../src/config/env.js';

runMigrations({
  connectionString: env.databaseUrl,
}).then(() => {
  console.log('Graphile Worker migration complete');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
