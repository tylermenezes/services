import debug from 'debug';
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
  pokemonActivity(scheduleObsidianDaily);
  pokemonActivity(scheduleIgnite);
}