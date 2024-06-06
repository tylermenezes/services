import schedule from 'node-schedule';
import { obsidian } from '@/services';
import { getEventsToday } from '@/datasources/calendar';
import { DateTime } from 'luxon';
import { Event } from 'ical.js';

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

function getAgendaEntry(event: Event) {
  const attendees = event.attendees?.length < 10
    ? event.attendees.map(a => `${JSON.parse(JSON.stringify(a))[1].cn}`)
    : [];
  return `## ${event.summary}\n${attendees.length > 0 ? `\n**Attendees:** ${attendees.join(', ')}\n` : ''}\n- `;
}

export async function obsidianDaily() {
  const dailyPath = 'daily/' + DateTime.now().toFormat('yyyy/LL-LLL/yyyy-LL-dd') + '.md';
  if (!obsidian.noteExists(dailyPath)) {
    const agenda = getEventsToday().map(getAgendaEntry);
    const data = dailyTemplate() + `\n\n` + agenda;
    obsidian.noteWrite(dailyPath, data);
  }
}

export function scheduleObsidianDaily() {
  const job = schedule.scheduleJob('*/7 * * * *', obsidianDaily);
  job.invoke();
}
