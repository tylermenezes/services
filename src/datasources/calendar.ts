import schedule from 'node-schedule';
import IcalExpander from 'ical-expander';
import { DateTime } from 'luxon';
import fetch from 'cross-fetch';
import config from '@/config';
import { Event } from 'ical.js';
import debug from 'debug';

const DEBUG = debug('services:datasources:calendar');

type ExtendedEvent = Event & { organizer?: string };

let calendars: string[] = [];
export function getEvents(after: Date, before: Date) {
  const matchingEvents = Object.fromEntries(
    calendars
      .map(ics => new IcalExpander({ ics }))
      .filter(Boolean)
      .flatMap(c => {
        const { events, occurrences } = c.between(after, before);
        return [
          ...events,
          ...occurrences
            .map(o => ({
              uid: o.item.uid,
              summary: o.item.summary,
              startDate: o.startDate,
              endDate: o.endDate,
              description: o.item.description,
              location: o.item.location,
              attendees: o.item.attendees,
              component: o.item.component,
            }) as Event)
        ]
        .map((e: ExtendedEvent) => {
          if (
            e.component.getFirstProperty("organizer")
            && typeof e.component.getFirstProperty("organizer").getFirstValue() === 'string'
          ) {
            e.organizer = e.component
              .getFirstProperty("organizer")
              .getFirstValue()
              .replace('mailto:', '');
          }
          return e;
        });
      })
      .sort((a, b) => a.startDate < b.startDate ? -1 : 1)
      .map(e => [e.uid, e]) // Deduplicate
  );

  return Object.values(matchingEvents);
}

export function getEventsOnDay(date: Date) {
  return getEvents(
    DateTime.fromJSDate(date).startOf('day').toJSDate(),
    DateTime.fromJSDate(date).endOf('day').toJSDate()
  );
}

export function getEventsToday() {
  return getEventsOnDay(DateTime.now().toJSDate());
}

export function getEventsTomorrow() {
  return getEventsOnDay(DateTime.now().plus({ days: 1 }).toJSDate());
}

async function calendarUpdate() {
  DEBUG('Updating calendars.');
  calendars = await Promise.all(
    config.calendars.map(url => fetch(url).then(r => r.text()))
  );
  DEBUG(`${calendars.length} calendars fetched.`)
}

export async function scheduleCalendarUpdate() {
  await calendarUpdate();
  const job = schedule.scheduleJob('*/5 * * * *', calendarUpdate);
}