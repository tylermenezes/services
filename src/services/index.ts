import config from '@/config';
import { v9 as Todoist } from 'todoist';
import { Obsidian } from './Obsidian';
import { TripIt } from './TripIt';
export * from './TripIt';

export const tripit = new TripIt(config.tripit.consumerKey, config.tripit.consumerSecret);
export const obsidian = new Obsidian(config.obsidian.couchDbUrl, config.obsidian.couchDb);
export const todoist = Todoist(config.todoist.apiKey);
