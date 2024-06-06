import config from './config';
import { v9 as Todoist } from 'todoist';
import nano from 'nano';

export const obsidian = nano(config.obsidian.couchDbUrl)
  .use(config.obsidian.couchDb);
export const todoist = Todoist(config.todoist.apiKey);
