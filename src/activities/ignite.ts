import schedule from "node-schedule";
import fetch from "cross-fetch";
import debug from "debug";
import config from "@/config";
import fromAsync from "array-from-async";

const DEBUG = debug("services:activities:obsidianDaily");

interface TicketTailorEventsResponse {
  data: {
    id: string;
    name: string;
    hidden: "true" | "false";
    private: "true" | "false";
    status: "published" | "draft" | "close_sales";
    total_holds: number;
    total_issued_tickets: number;
    total_orders: number;
    unavailable: "true" | "false";
    url: string;
  }[];
}

interface TicketTailorOrdersResponse {
  data: {
    id: string;
    event_id: string;
    created_at: string;
    issued_tickets: object[];
    referral_tag?: string;
    status: "completed" | "pending" | "cancelled";
  }[];
}

async function fetchTicketTailorDetails() {
  return fetch("https://api.tickettailor.com/v1/events", {
    headers: {
      Authorization: `Basic ${config.ignite.tickettailorKey}`,
      Accept: "application/json",
    },
  })
    .then((r) => r.json() as unknown as TicketTailorEventsResponse)
    .then((r) => r.data);
}

async function fetchTicketTailorOrders(eventId: string) {
  const orders: TicketTailorOrdersResponse["data"] = [];
  let hasMore = true;
  while (hasMore) {
    const after = orders.length > 0 ? orders[orders.length - 1].id : "";
    DEBUG(`Fetching orders after ${after}`);
    const page = await fetch(
      `https://api.tickettailor.com/v1/orders?event_id=${eventId}&starting_after=${after}`,
      {
        headers: {
          Authorization: `Basic ${config.ignite.tickettailorKey}`,
          Accept: "application/json",
        },
      },
    )
      .then((r) => r.json() as unknown as TicketTailorOrdersResponse)
      .then((r) => r.data);
    hasMore = page.length > 0;
    orders.push(...page);
  }
  return orders;
}

async function postSlackMessage(slackMessage: string) {
  await fetch(config.ignite.slackWebhook, {
    method: "POST",
    headers: {
      "Content-type": "text/json",
    },
    body: JSON.stringify({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: slackMessage,
          },
        },
      ],
    }),
  });
}

async function* getTicketTailorEventsAndReferrals(): AsyncGenerator<{
  name: string;
  tickets: number;
  referrals: Record<string, number>;
}> {
  const events = (await fetchTicketTailorDetails()).filter(
    (e) => e.status === "published",
  );

  for (const event of events) {
    const orders = await fetchTicketTailorOrders(event.id);
    const referrals = orders
      .filter((o) => o.referral_tag)
      .reduce(
        (acc, o) => {
          acc[o.referral_tag || ""] =
            (acc[o.referral_tag || ""] || 0) + o.issued_tickets.length;
          return acc;
        },
        {} as Record<string, number>,
      );

    yield { name: event.name, tickets: event.total_issued_tickets, referrals };
  }
}

export async function postIgniteTicketUpdate() {
  const events = await fromAsync(getTicketTailorEventsAndReferrals());

  if (!events || events.length === 0) return;
  DEBUG(`${events.length} live Ignite events found.`);

  const slackMessage = events
    .map(
      (e) =>
        `- ${e.name}: ${e.tickets} tickets (${Object.entries(e.referrals)
          .map(([referral, count]) => `${"`"}${referral}${"`"}: ${count}`)
          .join(`, `)})`,
    )
    .join(`\n`);
  await postSlackMessage(slackMessage);
}

export function scheduleIgnite() {
  schedule.scheduleJob("0 12 * * *", postIgniteTicketUpdate);
}
