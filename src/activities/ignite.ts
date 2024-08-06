import schedule from 'node-schedule';
import fetch from 'cross-fetch';
import debug from 'debug';
import config from '@/config';

const DEBUG = debug('services:activities:obsidianDaily');

interface TicketTailorEventsResponse {
  data: {
    id: string
    name: string
    hidden: 'true' | 'false'
    private: 'true' | 'false'
    status: 'published' | 'draft' | 'close_sales'
    total_holds: number
    total_issued_tickets: number
    total_orders: number
    unavailable: 'true' | 'false'
    url: string
  }[]
}

async function fetchTicketTailorDetails() {
  return fetch('https://api.tickettailor.com/v1/events', {
    headers: {
      Authorization: `Basic ${config.ignite.tickettailorKey}`,
      Accept: 'application/json'
    }
  })
  .then(r => r.json() as unknown as TicketTailorEventsResponse)
  .then(r => r.data);
}

export async function postIgniteTicketUpdate() {
  const events = (await fetchTicketTailorDetails())
    .filter(e => e.status === 'published');

  DEBUG(`${events.length} live Ignite events found.`);
  
  if (!events || events.length === 0) return;

  const slackMessage = events
    .map(e => `- ${e.name}: ${e.total_issued_tickets}`)
    .join(`\n`);

  await fetch(config.ignite.slackWebhook, {
    method: 'POST',
    headers: {
      'Content-type': 'text/json',
    },
    body: JSON.stringify({ text: slackMessage })
  });
}

export function scheduleIgnite() {
  schedule.scheduleJob('0 12 * * *', postIgniteTicketUpdate);
}
