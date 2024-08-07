import config from '@/config';
import { v9 as Todoist } from 'todoist';
import { Obsidian } from './Obsidian';
import { TripIt } from './TripIt';
import { DAVClient } from 'tsdav';
import { Timeshifter } from './Timeshifter';
import LastFmApi from 'lastfm-nodejs-client';

export * from './TripIt';
export * from './Obsidian';

export const lastFm = LastFmApi();
lastFm.config.api_key = config.lastFm.apiKey;
lastFm.config.share_secret = config.lastFm.apiSecret;
lastFm.config.username = config.lastFm.username;
lastFm.config.base_url = 'http://ws.audioscrobbler.com/2.0/';

export const tripit = new TripIt(
  config.tripit.consumerKey,
  config.tripit.consumerSecret
);

export const obsidian = new Obsidian(
  config.obsidian.couchDbUrl,
  config.obsidian.couchDb
);

export const todoist = Todoist(config.todoist.apiKey);

export const timeshifter = new Timeshifter(
  config.timeshifter.email,
  config.timeshifter.password,
  config.timeshifter.token
);

export const contacts = {
  apple: new DAVClient({
    serverUrl: 'https://contacts.icloud.com',
    credentials: {
      username: config.apple.username,
      password: config.apple.appPassword,
    },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  }),
  codeday: new DAVClient({
    serverUrl: 'https://apidata.googleusercontent.com/caldav/v2/',
    credentials: {
      username: config.google.username,
      password: config.google.appPassword,
    },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  }),
};