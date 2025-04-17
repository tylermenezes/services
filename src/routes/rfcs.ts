import { Router } from 'express';
import { getRfcs } from '@/datasources';

const router = Router();

router.get('/rfcs.json', async (_, res) => {
  res.send(getRfcs());
});

export default router;
