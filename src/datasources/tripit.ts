import schedule from 'node-schedule';
import { TripIt, tripit, TripItFlight, TripItFlightSegment, TripItListTripResponse, TripItTrip } from '@/clients';
import config from '@/config';
import { DateTime } from 'luxon';
import debug from 'debug';

const DEBUG = debug('services:datasources:tripit');

export interface TripResponse {
  startDate: Date
  endDate: Date
  location: string
}

export type FlightSegment = TripItFlightSegment & { start_date: Date, end_date: Date };
let trips: (Omit<TripItTrip, 'start_date' | 'end_date'> & { start_date: Date, end_date: Date, flights: TripItFlight[] })[] = [];
let flightSegments: FlightSegment[] = [];

export function getUpcomingTrips() {
  return trips;
}

export function getFlightSegments() {
  return flightSegments;
}

async function fetchPages<T extends { page_num?: string, max_page?: string }>(
  endpoint: string,
  method: string,
  page?: number,
): Promise<T[]> {
  console.log(`Fetching page ${page}`);
  const resp = await tripit.requestResource<T>(
    page ? `${endpoint}/page_num/${page}` : endpoint,
    method,
    config.tripit.accessToken!,
    config.tripit.accessTokenSecret!
  );

  if (!resp.page_num || !resp.max_page) return [resp];
  const pageNum = Number.parseInt(resp.page_num);
  const maxPage = Number.parseInt(resp.max_page);

  DEBUG(`Pagenated response detected, loading page ${pageNum+1}/${maxPage}`);

  if (pageNum >= maxPage) return [resp];
  return [
    resp,
    ...(await fetchPages<T>(endpoint, method, pageNum+1))
  ];
}

async function tripItUpdate() {
  DEBUG('Updating tripit.');
  const now = new Date();

  const tripItResponse = await fetchPages<TripItListTripResponse>(
    '/list/trip/past/true/page_size/25',
    'GET'
  ).then(resp => resp.flatMap(p => {
    if (typeof p === 'undefined' || typeof p.Trip === 'undefined') return [];
    if (Array.isArray(p.Trip)) return p.Trip;
    return p.Trip;
  }));

  const tripsRaw = tripItResponse
    .map((t) => ({
      ...t,
      start_date: DateTime.fromISO(t.start_date).toJSDate(),
      end_date: DateTime.fromISO(t.end_date).toJSDate(),
    }))
    .sort((a, b) => a.start_date < b.start_date ? -1 : 1);

  // Only fetch flights for upcoming trips
  const flights = Object.fromEntries(
    await Promise.all(
      tripsRaw.filter(t => t.end_date > now).map(async (t) => [
        t.id,
        await tripit.requestResource<{AirObject: TripItFlight[]}>(
          `/list/object/trip_id/${t.id}/type/air`,
          'GET',
          config.tripit.accessToken!,
          config.tripit.accessTokenSecret!,
        ).then(t => t?.AirObject || [])
      ])
    )
  );

  trips = tripsRaw.map(t => ({
    ...t,
    flights: flights[t.id] || [],
  }));

  flightSegments = trips
    .flatMap(t => t.flights || [])
    .flatMap(f => f.Segment || [])
    .filter(s => s.StartDateTime && s.EndDateTime)
    .map(s => ({
      ...s,
      start_date: TripIt.convertDateTime(s.StartDateTime!),
      end_date: TripIt.convertDateTime(s.EndDateTime!),
    }))
    .sort((a, b) => a.start_date < b.start_date ? -1 : 1);

  DEBUG(`${trips.length} trips and ${flightSegments.length} segments fetched.`);
}

export async function scheduleTripItUpdate() {
  try {
    await tripItUpdate();
  } catch (ex) { DEBUG(ex); }
  const job = schedule.scheduleJob('10 * * * *', tripItUpdate);
}