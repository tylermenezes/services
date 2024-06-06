import { scheduleDatasourceUpdates } from '@/datasources';
import { scheduleActivities } from '@/activities';
import { startServer } from './server';

(async () => {
  await scheduleDatasourceUpdates();
  scheduleActivities();
  startServer();
})();
