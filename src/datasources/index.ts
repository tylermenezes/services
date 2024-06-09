import { scheduleCalendarUpdate } from "./calendar";
import { scheduleTripItUpdate } from "./tripit";
import { scheduleRfcUpdate } from "./rfc";
import { scheduleContactsUpdate } from "./contacts";

export async function scheduleDatasourceUpdates() {
  await scheduleContactsUpdate();
  await scheduleCalendarUpdate();
  await scheduleTripItUpdate();
  await scheduleRfcUpdate();
}

export * from './tripit';
export * from './calendar';
export * from './cv';
export * from './rfc';
export * from './contacts';