import { scheduleTodoistDates } from "./todoistDates";
import { scheduleObsidianDaily } from "./obsidianDaily";
import { timeshifterSync } from './timeshifterSync';

export function scheduleActivities() {
  timeshifterSync();
  scheduleTodoistDates();
  scheduleObsidianDaily();
}