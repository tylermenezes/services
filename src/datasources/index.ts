import { scheduleCalendarUpdate } from "./calendar";
import { scheduleTripItUpdate } from "./tripit";
import { scheduleRfcUpdate } from "./rfc";

export async function scheduleDatasourceUpdates() {
  await scheduleCalendarUpdate();
  await scheduleTripItUpdate();
  await scheduleRfcUpdate();
}

export * from './tripit';
export * from './calendar';
export * from './cv';
export * from './rfc';