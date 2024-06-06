import { config as loadEnv } from 'dotenv';
import { obsidian } from './services';
loadEnv();

const missing = ['TODOIST_API_KEY', 'OBSIDIAN_COUCHDB_URL'].filter(e => !process.env[e]);
if (missing.length > 0) throw new Error(`The following envvars are required: ${missing.join(', ')}`);

export default {
  todoist: {
    apiKey: process.env.TODOIST_API_KEY!,
  },
  obsidian: {
    couchDbUrl: process.env.OBSIDIAN_COUCHDB_URL!,
    couchDb: process.env.OBSIDIAN_COUCHDB_DB || 'obsidian',
  },
  calendars: Object.entries(process.env).filter(([k]) => k.startsWith('CALENDAR_')).map(([_, v]) => v!),
}
