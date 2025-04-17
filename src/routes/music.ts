import { Router } from 'express';
import { getTopMusic } from '@/datasources';

const router = Router();

router.get('/music.json', async (_, res) => {
  res.send(getTopMusic());
});

export default router;
