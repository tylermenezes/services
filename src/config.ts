import { config as loadEnv } from 'dotenv';
loadEnv();

const missing = [
  'TODOIST_API_KEY',
  'OBSIDIAN_COUCHDB_URL',
  'OBSIDIAN_CV_NOTE',
  'TRIPIT_CONSUMER_KEY',
  'TRIPIT_CONSUMER_SECRET',
  'APPLE_USERNAME',
  'APPLE_APP_PASSWORD',
  'GOOGLE_USERNAME',
  'GOOGLE_APP_PASSWORD',
  'TIMESHIFTER_EMAIL',
  'TIMESHIFTER_PASSWORD',
  'IGNITE_TICKETTAILOR_KEY',
  'IGNITE_SLACK_WEBHOOK',
  'LASTFM_API_KEY',
  'LASTFM_API_SECRET',
  'LASTFM_SESSION_TOKEN',
  'LASTFM_USERNAME',
  'MY_EMAILS',
  'MY_NAME',
  'APP_SECRET',
  'IGNITE_COGNITOFORMS_FORM_ID',
  'IGNITE_COGNITOFORMS_API_KEY',
  'SERVICES_COUCHDB_URL',
].filter(e => !process.env[e]);
if (missing.length > 0) throw new Error(`The following envvars are required: ${missing.join(', ')}`);

export default {
  app: {
    secret: process.env.APP_SECRET!,
    port: process.env.PORT || 3000,
    myEmails: process.env.MY_EMAILS!.split(',').filter(Boolean),
    myName: process.env.MY_NAME!,
  },
  todoist: {
    apiKey: process.env.TODOIST_API_KEY!,
  },
  apple: {
    username: process.env.APPLE_USERNAME!,
    appPassword: process.env.APPLE_APP_PASSWORD!,
  },
  google: {
    username: process.env.GOOGLE_USERNAME!,
    appPassword: process.env.GOOGLE_APP_PASSWORD!,
  },
  ignite: {
    tickettailorKey: process.env.IGNITE_TICKETTAILOR_KEY!,
    slackWebhook: process.env.IGNITE_SLACK_WEBHOOK!,
    cognitoformsApiKey: process.env.IGNITE_COGNITOFORMS_API_KEY!,
    cognitoformsFormId: process.env.IGNITE_COGNITOFORMS_FORM_ID!,
  },
  timeshifter: {
    email: process.env.TIMESHIFTER_EMAIL!,
    password: process.env.TIMESHIFTER_PASSWORD!,
    token: process.env.TIMESHIFTER_TOKEN, // Useful to avoid multiple calls to login() for debugging
  },
  lastFm: {
    apiKey: process.env.LASTFM_API_KEY!,
    apiSecret: process.env.LASTFM_API_SECRET!,
    session: process.env.LASTFM_SESSION_TOKEN!,
    username: process.env.LASTFM_USERNAME!,
  },
  obsidian: {
    couchDbUrl: process.env.OBSIDIAN_COUCHDB_URL!,
    couchDb: process.env.OBSIDIAN_COUCHDB_DB || 'obsidian',
    cvNote: process.env.OBSIDIAN_CV_NOTE!,
  },
  services: {
    couchDbUrl: process.env.SERVICES_COUCHDB_URL!,
    couchDb: process.env.SERVICES_COUCHDB_DB || 'services',
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
