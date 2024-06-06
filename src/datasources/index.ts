import { scheduleCalendarUpdate } from "./calendar";
import { scheduleTripItUpdate } from "./tripit";

export async function scheduleDatasourceUpdates() {
  await scheduleCalendarUpdate();
  await scheduleTripItUpdate();
}

export * from './tripit';
export * from './calendar';
export * from './cv';