import { scheduleTodoistDates } from "./todoistDates";
import { scheduleObsidianDaily } from "./obsidianDaily";

export function scheduleActivities() {
  scheduleTodoistDates();
  scheduleObsidianDaily();
}