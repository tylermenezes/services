import { config as loadEnv } from 'dotenv';
loadEnv();

const missing = ['TODOIST_API_KEY'].filter(e => !process.env[e]);
if (missing.length > 0) throw new Error(`The following envvars are required: ${missing.join(', ')}`);

export default {
  todoist: {
    apiKey: process.env.TODOIST_API_KEY!,
  },
}
