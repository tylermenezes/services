import schedule from 'node-schedule';
import { obsidian } from './services';
import { getEventsToday } from './utils/calendar';
import { createHash } from 'crypto';
import { DateTime } from 'luxon';

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

async function fileExists(key: string): Promise<boolean> {
  try {
    await obsidian.head(key);
    return true;
  } catch (ex) { return false; }
}

export async function writeObsidian() {
  const todayKey = 'daily/' + DateTime.now().toFormat('yyyy/LL-LLL/yyyy-LL-dd') + '.md';
  if (!await fileExists(todayKey)) {
    console.log(`Creating daily agenda ${todayKey}`);
    const agenda = getEventsToday().map(e => `## ${e.summary}\n**Attendees:** ${e.attendees?.length < 10 ? e.attendees.map(a => `${JSON.parse(JSON.stringify(a))[1].cn}`).join(', ') : ''}\n\n- `);
    const data = dailyTemplate() + `\n\n` + agenda;
    const id = 'h:' + createHash('sha1').update(data).digest('base64').slice(0,13);
    const time = DateTime.now().toUnixInteger();
    const leafVal = {
      _id: id,
      data,
      type: 'leaf',
    };

    const origVal = {
      _id: todayKey,
      path: todayKey,
      ctime: time,
      mtime: time,
      size: data.length,
      type: 'plain',
      children: [id],
      eden: {},
    };

    await obsidian.insert(leafVal);
    await obsidian.insert(origVal)
  }
}

export function scheduleWriteObsidian() {
  const job = schedule.scheduleJob('*/7 * * * *', writeObsidian);
  job.invoke();
}
