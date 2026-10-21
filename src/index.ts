import { scheduleDatasourceUpdates } from '@/datasources';
import { scheduleActivities } from '@/activities';
import { startServer } from './server';
import config from '@/config';

// Background syncs hit flaky third-party APIs; serving stale data beats crashing the whole server.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

(async () => {
  if (!config.app.disableDatasourceUpdates) await scheduleDatasourceUpdates();
  if (!config.app.disableActivities) scheduleActivities();
  startServer();
})();
