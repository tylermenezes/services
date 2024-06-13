import { todoist } from '@/clients';
import schedule from 'node-schedule';
import { DueDate, Item } from 'todoist/dist/v9-types';
import debug from 'debug';

const DEBUG = debug('services:activities:todoistDates');

export async function todoistDates() {
  DEBUG('Syncing');
  await todoist.sync();
  DEBUG(`Synced`);
  const withoutTime = todoist.items.get().filter((e: Item) => !e.checked && e.due?.date && !e.due.date.includes('T'));

  DEBUG(`Updating ${withoutTime.length} tasks without a due time.`);
  for (const item of withoutTime) {
    DEBUG(`- Adding default due time to ${item.content}`);
    const dueDate = item.due.string
      ? { string: `${item.due.string} at 4pm`, date: `${item.due.date}T16:00:00` }
      : { date: `${item.due.date}T16:00:00` };
    await todoist.items.update({
      id: item.id,
      due: dueDate as unknown as DueDate, // API supports this but Todoist Node module doesn't.
    });
  }
  DEBUG(`Done updating tasks without due time!`);
}

export function scheduleTodoistDates() {
  const job = schedule.scheduleJob('15 * * * *', todoistDates);
  job.invoke();
}
