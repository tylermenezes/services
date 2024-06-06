import config from './config';
import { v9 as Todoist } from 'todoist'

export const todoist = Todoist(config.todoist.apiKey);
