import Express from 'express';
import config from '@/config';
import {
  fetchCv,
  fetchCvTex,
  getRfcs,
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
  res.send(getUpcomingTrips().map(t => ({
    startDate: t.start_date,
    endDate: t.end_date,
    location: t.primary_location,
  })));
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

// HACK
async function tripitLogin() {
  if (config.tripit.requestToken && config.tripit.requestTokenSecret) {
    const [token, secret] = await tripit.getAccessToken(config.tripit.requestToken, config.tripit.requestTokenSecret);
    DEBUG(`TRIPIT_ACCESS_TOKEN=${token}`);
    DEBUG(`TRIPIT_ACCESS_TOKEN_SECRET=${secret}`);
  } else {
    const [token, secret] = await tripit.getRequestToken();
    DEBUG(`https://www.tripit.com/oauth/authorize?oauth_token=${token}&oauth_callback=http://localhost`);
    DEBUG(`TRIPIT_REQUEST_TOKEN=${token}`);
    DEBUG(`TRIPIT_REQUEST_TOKEN_SECRET=${secret}`);
  }
}

export async function startServer() {
  if (!config.tripit.accessToken || !config.tripit.accessTokenSecret) {
    await tripitLogin();
    return;
  }
  express
    .listen(
      config.app.port,
      () => DEBUG(`Listening on http://0.0.0.0:${config.app.port}`)
    );
}