import { todoist } from '@/services';
import schedule from 'node-schedule';
import { DueDate, Item } from 'todoist/dist/v9-types';

export async function todoistDates() {
  console.log(`Syncing...`);
  await todoist.sync();
  console.log('Done!');
  const withoutTime = todoist.items.get().filter((e: Item) => !e.checked && e.due?.date && !e.due.date.includes('T'));

  console.log(`Updating ${withoutTime.length} tasks without a due time.`);
  for (const item of withoutTime) {
    console.log(`- Adding default due time to ${item.content}`);
    const dueDate = item.due.string
      ? { string: `${item.due.string} at 4pm`, date: `${item.due.date}T16:00:00` }
      : { date: `${item.due.date}T16:00:00` };
    await todoist.items.update({
      id: item.id,
      due: dueDate as unknown as DueDate, // API supports this but Todoist Node module doesn't.
    });
  }
  console.log(`Done!`);
}

export function scheduleTodoistDates() {
  const job = schedule.scheduleJob('*/5 * * * *', todoistDates);
  job.invoke();
}
