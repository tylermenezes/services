import { config as loadEnv } from 'dotenv';
loadEnv();

const missing = [
  'TODOIST_API_KEY',
  'OBSIDIAN_COUCHDB_URL',
  'OBSIDIAN_CV_NOTE',
  'TRIPIT_CONSUMER_KEY',
  'TRIPIT_CONSUMER_SECRET',
].filter(e => !process.env[e]);
if (missing.length > 0) throw new Error(`The following envvars are required: ${missing.join(', ')}`);

export default {
  app: {
    port: process.env.PORT || 3000,
  },
  todoist: {
    apiKey: process.env.TODOIST_API_KEY!,
  },
  obsidian: {
    couchDbUrl: process.env.OBSIDIAN_COUCHDB_URL!,
    couchDb: process.env.OBSIDIAN_COUCHDB_DB || 'obsidian',
    cvNote: process.env.OBSIDIAN_CV_NOTE!,
  },
  calendars: Object.entries(process.env).filter(([k]) => k.startsWith('CALENDAR_')).map(([_, v]) => v!),
  tripit: {
    consumerKey: process.env.TRIPIT_CONSUMER_KEY!,
    consumerSecret: process.env.TRIPIT_CONSUMER_SECRET!,
    requestToken: process.env.TRIPIT_REQUEST_TOKEN,
    requestTokenSecret: process.env.TRIPIT_REQUEST_TOKEN_SECRET,
    accessToken: process.env.TRIPIT_ACCESS_TOKEN,
    accessTokenSecret: process.env.TRIPIT_ACCESS_TOKEN_SECRET,
  },
}
