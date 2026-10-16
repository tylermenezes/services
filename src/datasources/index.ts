import debug from "debug";
import { scheduleCalendarUpdate } from "./calendar";
import { scheduleTripItUpdate } from "./tripit";
import { scheduleContactsUpdate } from "./contacts";
import { scheduleLastFmUpdate } from "./lastfm";
import { scheduleZoteroUpdate } from "./zotero";

const DEBUG = debug("services:datasources");

async function pokemonDatasource(fn: () => Promise<any>) {
  try {
    await fn();
  } catch (ex) {
    DEBUG(ex);
  }
}

export async function scheduleDatasourceUpdates() {
  await pokemonDatasource(scheduleTripItUpdate);
  await pokemonDatasource(scheduleLastFmUpdate);
  await pokemonDatasource(scheduleContactsUpdate);
  await pokemonDatasource(scheduleCalendarUpdate);
  await pokemonDatasource(scheduleZoteroUpdate);
}

export * from "./tripit";
export * from "./calendar";
export * from "./cv";
export * from "./rfc";
export * from "./contacts";
export * from "./lastfm";
export * from "./zotero";
