import config from './config';
import { v8 as Todoist } from 'todoist'

export const todoist = Todoist(config.todoist.apiKey);
