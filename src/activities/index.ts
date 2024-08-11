import debug from 'debug';
import { scheduleTodoistDates } from "./todoistDates";
import { scheduleObsidianDaily } from "./obsidianDaily";
import { timeshifterSync } from './timeshifterSync';
import { scheduleIgnite } from "./ignite";

const DEBUG = debug('services:activities');

function pokemonActivity(fn: Function) {
  try { fn() }
  catch(ex){ DEBUG(ex); }
}

export function scheduleActivities() {
  pokemonActivity(timeshifterSync);
  pokemonActivity(scheduleTodoistDates);
  pokemonActivity(scheduleObsidianDaily);
  pokemonActivity(scheduleIgnite);
}