import schedule from 'node-schedule';
import { tripit, TripItListTripResponse } from '@/clients';
import config from '@/config';
import { DateTime } from 'luxon';
import debug from 'debug';

const DEBUG = debug('services:datasources:tripit');

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

export interface TripResponse {
  startDate: Date
  endDate: Date
  location: string
}

let trips: TripResponse[] = [];
export function getUpcomingTrips() {
  return trips;
}

async function tripItUpdate() {
  if (!config.tripit.accessToken || !config.tripit.accessTokenSecret) {
    await tripitLogin();
    return;
  }

  DEBUG('Updating tripit.');
  try {
    const tripsRaw = await tripit.requestResource<TripItListTripResponse>(
      '/list/trip',
      'GET',
      config.tripit.accessToken,
      config.tripit.accessTokenSecret
    );

    trips = (tripsRaw?.Trip || [])
      .map(t => ({
        startDate: DateTime.fromISO(t.start_date).toJSDate(),
        endDate: DateTime.fromISO(t.end_date).toJSDate(),
        location: t.primary_location,
      }))
      .sort((a, b) => a.startDate < b.startDate ? -1 : 1);
    DEBUG(`${trips.length} trips fetched.`);
  } catch (ex) {
    console.error(ex);
  }
}

export async function scheduleTripItUpdate() {
  await tripItUpdate();
  const job = schedule.scheduleJob('*/5 * * * *', tripItUpdate);
}