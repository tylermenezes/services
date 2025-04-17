import { Router } from 'express';
import { fetchCv, fetchCvTex } from '@/datasources';

const router = Router();

router.get('/cv.json', async (_, res) => {
  res.send(await fetchCv());
});

router.get('/cv.tex', async (_, res) => {
  res
    .setHeader('Content-type', 'text/plain')
    .send(await fetchCvTex());
});

export default router;
