import { scheduleCalendarUpdate } from "./utils/calendar";
import { scheduleFixDates } from "./fixDates";
import { scheduleWriteObsidian } from "./obsidian";

(async () => {
  await scheduleCalendarUpdate();
  scheduleFixDates();
  scheduleWriteObsidian();
})();