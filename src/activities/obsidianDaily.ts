import schedule from 'node-schedule';
import { obsidian } from '@/clients';
import { getEventsToday } from '@/datasources/calendar';
import { DateTime } from 'luxon';
import { Event } from 'ical.js';
import debug from 'debug';
import { getContact } from '@/datasources';
import { dedupe } from '@/utils';
import config from '@/config';

const DEBUG = debug('services:activities:obsidianDaily');

function dailyTemplate() {
  const now = DateTime.now();
  return '' +
`---
publish: False
---
# ${now.toFormat('dd-MMMM-yyyy')}
Tags: #y${now.toFormat('yyyy')} #y${now.toFormat('yyyy')}m${now.toFormat('MMM')} #d${now.toFormat('dd')}m${now.toFormat('MMM')}
`;
}

async function getAgendaEntry(event: Event) {
  const attendees = await Promise.all(
    event.attendees.map(async (a) => {
      const cn = JSON.parse(JSON.stringify(a))?.[1]?.cn as string;
      if (cn.includes('@') && !cn.trim().includes(' ')) {
        DEBUG(`Searching for contact with email ${cn}.`)
        const contact = getContact({ email: cn });
        if (contact) {
          DEBUG('Contact found!');
          return `[[@${contact.name.toLowerCase()}]]`;
        }
      } else if (cn.includes(' ')) { // name
        let fixedCn = cn.toLowerCase();

        if (cn.includes(', ')) { // last, first (company) => first last
          let [familyName, givenName] = cn.split(', ');
          if (givenName.includes(' (')) givenName = givenName.split(' (')[0];
          fixedCn = `${givenName} ${familyName}`;
        }

        return `[[@${fixedCn}]]`
      }

      return cn;
    })
  );

  const uniqueAttendees = dedupe(attendees)
    .filter(a => (
      !config.app.myEmails.includes(a)
      && a !== `[[@${config.app.myName.toLowerCase()}]]`
    ));
  if (uniqueAttendees.length === 0) return `## ${event.summary}\n\n`;

  const attendeesDisplayed = uniqueAttendees.length < 10
    ? uniqueAttendees
    : uniqueAttendees.filter(a => a.substring(0, 3) === '[[@');

  return `## ${event.summary}\n\n**Attendees:** ${attendeesDisplayed.join(', ')}\n`;
}

export async function obsidianDaily() {
  const dailyPath = 'daily/' + DateTime.now().toFormat('yyyy/LL-LLL/yyyy-LL-dd') + '.md';
  DEBUG(`Checking for ${dailyPath} in Obsidian.`);

  if (!await obsidian.noteExists(dailyPath)) {
    const meetings = getEventsToday()
      .filter(e => (
        (
          e.attendees.length > 1
          || (e.organizer && !config.app.myEmails.includes(e.organizer))
        )
        && !e.summary.includes('Hours Due')
      ));

    if (meetings.length === 0) {
      DEBUG(`No meetings on ${dailyPath}.`);
      return;
    }
    DEBUG(`Creating ${dailyPath} with ${meetings.length} meetings.`);

    const agenda = (await Promise.all(meetings.map(getAgendaEntry))).join(`\n\n`);
    const data = dailyTemplate() + `\n\n` + agenda;
    obsidian.noteWrite(dailyPath, data);
  }
}

export function scheduleObsidianDaily() {
  const job = schedule.scheduleJob('10 * * * *', obsidianDaily);
  job.invoke();
}
