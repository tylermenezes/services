import Express from 'express';
import config from '@/config';
import {
  fetchCv,
  fetchCvTex,
  getUpcomingTrips,
} from '@/datasources';

const express = Express();

express.get('/', (_, res) => {
  res.redirect(302, 'https://tyler.vc/');
});

express.get('/trips.json', (_, res) => {
  res.send(getUpcomingTrips());
});

express.get('/cv.json', async (_, res) => {
  res.send(await fetchCv());
});

express.get('/cv.tex', async (_, res) => {
  res
    .setHeader('Content-type', 'text/plain')
    .send(await fetchCvTex());
});

export function startServer() {
  express
    .listen(
      config.app.port,
      () => console.log(`Listening on http://0.0.0.0:${config.app.port}`)
    );
}