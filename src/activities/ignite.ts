import schedule from 'node-schedule';
import fetch from 'cross-fetch';
import debug from 'debug';
import config from '@/config';
import { benaroyaTickets, couchDb } from '@/clients';
import fromAsync from 'array-from-async';

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

interface TicketTailorOrdersResponse {
  data: {
    id: string
    event_id: string
    created_at: string
    issued_tickets: object[]
    referral_tag?: string
    status: 'completed' | 'pending' | 'cancelled'
  }[]
}

type CognitoSubmissionType = { IgniteNumber: string, Pitch: string };

const SUBMISSION_COUNT_PATH = 'ignite/submissionCount';
const LAST_SUBMISSION_PATH = 'ignite/lastSubmission';
const LAST_SUBMISSION_KEY = 'submissionNumber';

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

async function fetchTicketTailorOrders(eventId: string) {
  const orders: TicketTailorOrdersResponse['data'] = [];
  let hasMore = true;
  while (hasMore) {
    const after = orders.length > 0 ? orders[orders.length - 1].id : '';
    DEBUG(`Fetching orders after ${after}`);
    const page = (await fetch(`https://api.tickettailor.com/v1/orders?event_id=${eventId}&starting_after=${after}`, {
      headers: {
        Authorization: `Basic ${config.ignite.tickettailorKey}`,
        Accept: 'application/json'
      }
    })
    .then(r => r.json() as unknown as TicketTailorOrdersResponse)
    .then(r => r.data));
    hasMore = page.length > 0;
    orders.push(...page);
  }
  return orders;
}

async function postSlackMessage(slackMessage: string) {
  await fetch(config.ignite.slackWebhook, {
    method: 'POST',
    headers: {
      'Content-type': 'text/json',
    },
    body: JSON.stringify({
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": slackMessage,
          }
        },
      ]
    })
  });
}

async function* getTicketTailorEventsAndReferrals(): AsyncGenerator<{name: string, tickets: number, referrals: Record<string, number>}> {
  const events = (await fetchTicketTailorDetails())
    .filter(e => e.status === 'published');

  for (const event of events) {
    const orders = await fetchTicketTailorOrders(event.id);
    const referrals = orders.filter(o => o.referral_tag).reduce((acc, o) => {
      acc[o.referral_tag || ''] = (acc[o.referral_tag || ''] || 0) + o.issued_tickets.length;
      return acc;
    }, {} as Record<string, number>);

    yield { name: event.name, tickets: event.total_issued_tickets, referrals };
  };
}

export async function postIgniteTicketUpdate() {
  const events = await fromAsync(getTicketTailorEventsAndReferrals());

  if (!events || events.length === 0) return;
  DEBUG(`${events.length} live Ignite events found.`);

  const slackMessage = events
    .map(e => `- ${e.name}: ${e.tickets} tickets (${Object.entries(e.referrals).map(([referral, count]) => `${'`'}${referral}${'`'}: ${count}`).join(`, `)})`)
    .join(`\n`);
  await postSlackMessage(slackMessage);
}


export async function updateAndPostIgniteSubmissions() {
  let lastSubmission: number = await couchDb.readKey(LAST_SUBMISSION_PATH, LAST_SUBMISSION_KEY, 214); // TODO
  const submissionCounts: Record<string, number> = await couchDb.read(SUBMISSION_COUNT_PATH, {});
  DEBUG(`Checking for new submissions since #${lastSubmission}.`);

  const newSubmissions: Record<string, CognitoSubmissionType[]> = {};

  try {
    while(lastSubmission++) {
      const result = await fetch(`https://www.cognitoforms.com/api/forms/${config.ignite.cognitoformsFormId}/entries/${lastSubmission}?access_token=${config.ignite.cognitoformsApiKey}`)
        .then(r => r.json()) as CognitoSubmissionType;
      if (!result.IgniteNumber) throw new Error();
      DEBUG(`Submission #${lastSubmission} for ${result.IgniteNumber} found.`);

      if (!(result.IgniteNumber in newSubmissions)) newSubmissions[result.IgniteNumber] = [];
      newSubmissions[result.IgniteNumber].push(result);
    }
  } catch {}

  for (const [igniteNumber, submissions] of Object.entries(newSubmissions)) {
    let igniteSubmissionCount = submissionCounts[igniteNumber] || 0;
    for (const submission of submissions) {
      await postSlackMessage(`Ignite #${submission.IgniteNumber} talk submission #${++igniteSubmissionCount}:\n>${submission.Pitch.split(`\n`).join(`\n>`)}`);
    }
    submissionCounts[igniteNumber] = igniteSubmissionCount;
  }

  await couchDb.setKey(LAST_SUBMISSION_PATH, LAST_SUBMISSION_KEY, lastSubmission);
  await couchDb.set(SUBMISSION_COUNT_PATH, submissionCounts);
}

export async function postIgniteBenaroyaTicketUpdate() {
  try {
    const { soldSeats, totalSeats } = await benaroyaTickets.fetchAllSectionTickets(
      config.ignite.benaroyaPerformanceId,
      config.ignite.benaroyaFacilityId,
      config.ignite.benaroyaScreenIds
    );

    await postSlackMessage(`${soldSeats}/${totalSeats} tickets sold at Benaroya Hall.`);
  } catch (ex) { DEBUG(ex); }
}

export function scheduleIgnite() {
  //schedule.scheduleJob('0 12 * * *', postIgniteTicketUpdate);
  schedule.scheduleJob('0 12 * * *', postIgniteBenaroyaTicketUpdate);
}
