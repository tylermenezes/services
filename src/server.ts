import Express from 'express';
import config from '@/config';
import {
  fetchCv,
  fetchCvTex,
  getRfcs,
  getTopMusic,
  getUpcomingTrips,
} from '@/datasources';
import debug from 'debug';
import { tripit } from './clients';

const DEBUG = debug('services:server');

const express = Express();

express.get('/', (_, res) => {
  res.redirect(302, 'https://tyler.vc/');
});

express.get('/trips.json', (_, res) => {
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

express.get('/cv.json', async (_, res) => {
  res.send(await fetchCv());
});

express.get('/cv.tex', async (_, res) => {
  res
    .setHeader('Content-type', 'text/plain')
    .send(await fetchCvTex());
});

express.get('/rfcs.json', async (_, res) => {
  res.send(getRfcs());
})

express.get('/music.json', async (_, res) => {
  res.send(getTopMusic());
});

const tripItSecrets: Record<string, string> = {};

express.get(`/tripit/login/${config.app.secret}`, async (req, res) => {
  const [token, secret] = await tripit.getRequestToken();
  tripItSecrets[token] = secret;
  res.redirect(`https://www.tripit.com/oauth/authorize?oauth_token=${token}&oauth_callback=https://svc.tyler.vc/tripit/login/${config.app.secret}/return/${token}`);
});

express.get(`/tripit/login/${config.app.secret}/return/:token`, async (req, res) => {
  const requestSecret = tripItSecrets[req.params.token];
  const [token, secret] = await tripit.getAccessToken(req.params.token, requestSecret);
  config.tripit.accessToken = token;
  config.tripit.accessTokenSecret = secret;

  res
    .header('Content-type', 'text/plain')
    .send(`TRIPIT_ACCESS_TOKEN=${token}\nTRIPIT_ACCESS_TOKEN_SECRET=${secret}`);
});

export async function startServer() {
  express
    .listen(
      config.app.port,
      () => DEBUG(`Listening on http://0.0.0.0:${config.app.port}`)
    );
}