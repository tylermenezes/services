import { Router } from 'express';
import { getUpcomingTrips } from '@/datasources';

const router = Router();

router.get('/trips.json', (_, res) => {
  const now = new Date();
  res.send(
    getUpcomingTrips()
      .map(t => ({
      startDate: t.start_date,
      endDate: t.end_date,
      upcoming: t.start_date > now,
      active: t.start_date <= now && t.end_date > now,
      location: t.primary_location,
      city: t.PrimaryLocationAddress?.city,
      state: t.PrimaryLocationAddress?.state,
      country: t.PrimaryLocationAddress?.country,
      }))
    .sort((a, b) => a.startDate < b.startDate ? 1 : -1)
  );
});

export default router;
