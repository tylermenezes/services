import { timeshifter } from '@/clients';
import schedule from 'node-schedule';
import debug from 'debug';
import { getFlightSegments, FlightSegment } from '@/datasources';
import { DateTime } from 'luxon';
import { Timeshifter } from '@/clients/Timeshifter';

const DEBUG = debug('services:activities:timeshifterSync');

const MIN_TRIP_DAYS = 2;
const MIN_TZ_CHANGE_MIN = 3 * 60;
const TRIP_MAX_DAYS_AWAY = 30; // TODO

function parseOffset(offset: string): number {
  const sign = offset.trim().substring(0, 1);
  const [h, m] = offset.trim().substring(1).split(':'); 

  return (sign === '-' ? -1 : 1) * ((Number.parseInt(h) * 60) + Number.parseInt(m));
}

export async function timeshifterSync() {
  const segments = getFlightSegments();
  const possibleFlightGroups: FlightSegment[][] = [[]];
  for (const s of segments) {
    const i = possibleFlightGroups.length - 1;
    const j = possibleFlightGroups[i].length - 1;

    // If this is the first flight, it will always be included.
    if (j < 0) {
      possibleFlightGroups[i].push(s);
      continue;
    }
    
    const lastSegment = possibleFlightGroups[i][j];
    const layover = DateTime.fromJSDate(s.start_date).diff(DateTime.fromJSDate(lastSegment.end_date), 'days');

    // Check layover length and see if it should be in this group of flights or next one
    if (Math.abs(layover.days) >= MIN_TRIP_DAYS) possibleFlightGroups.push([s]);
    else possibleFlightGroups[i].push(s);
  }

  const tzChangeFlightGroups = possibleFlightGroups
    .filter((g) => {
      if (g.length <= 0) return false;

      const firstFlight = g[0];
      const lastFlight = g[g.length - 1];
      
      const tzOffset = Math.abs(
        parseOffset(lastFlight.EndDateTime!.utc_offset)
        - parseOffset(firstFlight.StartDateTime!.utc_offset)
      );
      return tzOffset >= MIN_TZ_CHANGE_MIN;
    });

  if (
    tzChangeFlightGroups.length === 0
    || Math.abs(
      DateTime.now().diff(
        DateTime.fromJSDate(tzChangeFlightGroups[0][0].start_date),
        'days'
      ).days
    ) > TRIP_MAX_DAYS_AWAY
  ) {
    DEBUG(`No flights planned soon with significant time change.`);
    return;
  }

  const nextFlight = tzChangeFlightGroups[0];
  DEBUG(`Configuring timeshifter for ${nextFlight[0].StartDateTime!.date} ${nextFlight[0].start_airport_code}->${nextFlight.map(f => f.end_airport_code).join('->')}`);

  if ((await timeshifter.user()).trips.length > 0) {
    DEBUG(`Timeshifter already confirged.`);
    return;
  }

  const itinerary = [
    nextFlight.map((f) => ({
      departureAirport: f.start_airport_code!,
      departureTime: `${f.StartDateTime!.date}T${f.StartDateTime!.time}`,
      arrivalAirport: f.end_airport_code!,
      arrivalTime: `${f.EndDateTime!.date}T${f.EndDateTime!.time}`,
    })),
  ];

  const { maxPreadaptationDays } = await timeshifter.validateTrip({
    itinerary
  });

  DEBUG(`maxpreadaptationDays=${maxPreadaptationDays}`);

  const response = await timeshifter.createTrip({
    preadaptationDays: Math.min(2, maxPreadaptationDays),
    itinerary,
  });

  DEBUG(`Created timeshifter trip with ID ${response.id}.`);
}

export function scheduleTimeshifterSync() {
  const job = schedule.scheduleJob('4 */3 * * *', timeshifterSync);
  job.invoke();
}
