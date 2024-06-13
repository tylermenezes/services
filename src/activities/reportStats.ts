import schedule from 'node-schedule';
import os from 'os';
import { debug } from "console";

const DEBUG = debug('services:activities:reportStats');
const MB = 1024 * 1024;

export async function scheduleReportStats() {
  const job = schedule.scheduleJob('* * * * *',   () => debug(`memory: ${os.totalmem()/MB}mb total, ${os.freemem()/MB}mb free`));
  job.invoke();
}