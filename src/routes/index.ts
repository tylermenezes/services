import { Router } from 'express';

// Import route modules
import cvRoutes from './cv.js';
import tripsRoutes from './trips.js';
import rfcsRoutes from './rfcs.js';
import musicRoutes from './music.js';
import tripitRoutes from './tripit.js';
import rssRoutes from './rss.js';

const router = Router();

// Root route
router.get('/', (_, res) => {
  res.redirect(302, 'https://tyler.vc/');
});

// Register all routes
router.use(cvRoutes);
router.use(tripsRoutes);
router.use(rfcsRoutes);
router.use(musicRoutes);
router.use(tripitRoutes);
router.use(rssRoutes);

export default router;
