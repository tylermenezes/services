import { scheduleTodoistDates } from "./todoistDates";
import { scheduleObsidianDaily } from "./obsidianDaily";
import { timeshifterSync } from './timeshifterSync';
import { scheduleReportStats } from "./reportStats";

export function scheduleActivities() {
  timeshifterSync();
  scheduleTodoistDates();
  scheduleObsidianDaily();
  scheduleReportStats();
}