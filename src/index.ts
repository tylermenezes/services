import { scheduleDatasourceUpdates } from '@/datasources';
import { scheduleActivities } from '@/activities';
import { startServer } from './server';
import config from '@/config';

(async () => {
  if (!config.app.disableDatasourceUpdates) await scheduleDatasourceUpdates();
  if (!config.app.disableActivities) scheduleActivities();
  startServer();
})();
