import ICAL from "ical.js";
import { DateTime, Duration, DurationLikeObject } from "luxon";
import { bool, Fields, int, text } from "./database";

// How OmniFocus completes a repeating task, as observed in transactions it wrote (it calls this "stable repeats"):
//
// - A completed copy of the task is created with the ID `<id>.<next-clone-identifier>`, keeping the task's old dates
//   and every other field, ranked just before the original.
// - The original is updated in place with its next dates, and its next-clone-identifier is incremented.
// - Its parent's modified date is touched.
// - A rule limited to a number of times (COUNT=n) counts down: the copy keeps COUNT=n, and the original gets COUNT=n-1.
//   Completing it at COUNT=1 just completes it.
// - If it has subtasks, each gets a copy too (`<subtask id>.<its next-clone-identifier>`, under the parent's copy,
//   completed only if the subtask was), and the originals are reset to incomplete.
//
// The next date is computed for the anchor date (usually due), and the task's other dates keep the same wall-clock
// distance from it. "Fixed" repeats step from the old anchor date, one interval at a time even when overdue, unless
// catch-up is on. Repeats "from completion" step from the day the task was completed, at the anchor's time of day.

type Anchor = "dateDue" | "dateToStart" | "datePlanned";
const ANCHOR_FIELDS: Record<Anchor, string> = { dateDue: "due", dateToStart: "start", datePlanned: "planned" };
const DATE_FIELDS = ["start", "planned", "due"];
const FREQ_UNITS: Record<string, keyof DurationLikeObject> = {
  YEARLY: "years",
  MONTHLY: "months",
  WEEKLY: "weeks",
  DAILY: "days",
  HOURLY: "hours",
  MINUTELY: "minutes",
};

export interface Repetition {
  rule: string;
  method: string;
  scheduleType: "from-assigned" | "from-completion";
  anchor: Anchor;
  catchUp: boolean;
}

/**
 * A task's repeat settings, or null if it doesn't repeat. Tasks from before OmniFocus 4.7 only have a repetition
 * method; the schedule type and anchor are derived from it, as OmniFocus does when it clones them.
 */
export function repetitionOf(fields: Fields): Repetition | null {
  const rule = text(fields, "repetition-rule");
  if (!rule) return null;
  const method = text(fields, "repetition-method") ?? "fixed";
  const scheduleType = text(fields, "repetition-schedule-type") ?? (method === "fixed" ? "from-assigned" : "from-completion");
  const anchor = text(fields, "repetition-anchor-date") ?? (method === "start-after-completion" ? "dateToStart" : "dateDue");
  if (scheduleType !== "from-assigned" && scheduleType !== "from-completion")
    throw new Error(`Unknown repeat schedule type "${scheduleType}".`);
  if (!(anchor in ANCHOR_FIELDS)) throw new Error(`Unknown repeat anchor "${anchor}".`);
  return { rule, method, scheduleType, anchor: anchor as Anchor, catchUp: bool(fields, "catch-up-automatically") };
}

/** A stored date as wall-clock time (in a UTC DateTime, so arithmetic ignores DST), and whether it was absolute. */
interface WallDate {
  wall: DateTime;
  absolute: boolean;
}

function toWall(value: string, zone: string): WallDate {
  const absolute = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const local = DateTime.fromISO(value, { zone });
  if (!local.isValid) throw new Error(`Can't read the date "${value}".`);
  return { wall: local.setZone("UTC", { keepLocalTime: true }), absolute };
}

function fromWall({ wall, absolute }: WallDate, zone: string): string {
  if (!absolute) return wall.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
  return wall.setZone(zone, { keepLocalTime: true }).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}

/** The first occurrence of the rule, starting from `start`, which is after `after`; null if the repeat has ended. */
function nextOccurrence(rule: string, start: DateTime, after: DateTime): DateTime | null {
  const parts = Object.fromEntries(
    rule.split(";").map((p) => p.split("=") as [string, string]).map(([k, v]) => [k.toUpperCase(), v]),
  );
  const until = parts.UNTIL ? DateTime.fromISO(parts.UNTIL, { zone: "UTC" }) : null;
  if (until && !until.isValid) throw new Error(`Can't read the end date in the repeat rule ${rule}.`);

  let next: DateTime | null = null;
  const simple = Object.keys(parts).every((k) => ["FREQ", "INTERVAL", "UNTIL", "WKST"].includes(k));
  if (simple && FREQ_UNITS[parts.FREQ]) {
    // Calendar arithmetic, which clamps to the end of shorter months (Jan 31 + 1 month = Feb 28) as Foundation does.
    const interval = Number.parseInt(parts.INTERVAL ?? "1");
    for (let n = 1; !next || next <= after; n++) next = start.plus({ [FREQ_UNITS[parts.FREQ]]: interval * n });
  } else {
    const iterator = ICAL.Recur.fromString(rule).iterator(ICAL.Time.fromDateTimeString(start.toFormat("yyyy-MM-dd'T'HH:mm:ss")));
    for (let i = 0, t; i < 10000 && (t = iterator.next()); i++) {
      const candidate = DateTime.fromISO(t.toString(), { zone: "UTC" });
      if (candidate > after) {
        next = candidate;
        break;
      }
    }
  }
  return next && (!until || next <= until) ? next : null;
}

export interface NextDates {
  /** New values for the task's start, planned, and due fields that have dates. */
  dates: Record<string, string>;
  /** False if the repeat has ended, in which case the task should just be completed. */
  repeats: boolean;
  /** How far the dates moved, in wall-clock time, for moving subtasks' dates along with them. */
  shift: Duration;
  /** The task's new repeat rule, if it counts down. */
  rule?: string;
}

const NO_REPEAT: NextDates = { dates: {}, repeats: false, shift: Duration.fromMillis(0) };

function currentDates(fields: Fields, zone: string) {
  return Object.fromEntries(DATE_FIELDS.filter((f) => text(fields, f)).map((f) => [f, toWall(text(fields, f)!, zone)]));
}

/** A task's dates, moved by the given wall-clock duration. */
export function shiftDates(fields: Fields, shift: Duration, zone: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(currentDates(fields, zone)).map(([f, d]) => [f, fromWall({ wall: d.wall.plus(shift), absolute: d.absolute }, zone)]),
  );
}

/** The task's dates for its next repetition, given when it was completed. */
export function nextDates(fields: Fields, repetition: Repetition, completed: DateTime, zone: string): NextDates {
  const current = currentDates(fields, zone);
  // If the anchor date isn't set, OmniFocus can only go by one that is.
  const anchorField = [ANCHOR_FIELDS[repetition.anchor], "due", "start", "planned"].find((f) => current[f]);
  if (!anchorField) throw new Error("It repeats, but has no dates to repeat from.");
  const anchor = current[anchorField].wall;

  // OmniFocus keeps the number of repetitions left in the rule itself.
  const count = repetition.rule.match(/(^|;)COUNT=(\d+)/i);
  if (count && Number(count[2]) <= 1) return NO_REPEAT;
  const rule = count ? repetition.rule.replace(/(^|;)COUNT=\d+/i, "").replace(/^;/, "") : repetition.rule;

  let next: DateTime | null;
  if (repetition.scheduleType === "from-assigned") {
    const now = DateTime.now().setZone(zone).setZone("UTC", { keepLocalTime: true });
    next = nextOccurrence(rule, anchor, repetition.catchUp && now > anchor ? now : anchor);
  } else {
    // From the day it was completed, at the anchor's time of day.
    const day = completed.setZone(zone);
    const base = anchor.set({ year: day.year, month: day.month, day: day.day });
    next = nextOccurrence(rule, base, base);
  }
  if (!next) return NO_REPEAT;
  const shift = next.diff(anchor);
  return {
    dates: shiftDates(fields, shift, zone),
    repeats: true,
    shift,
    rule: count ? repetition.rule.replace(/(^|;)COUNT=\d+/i, `$1COUNT=${Number(count[2]) - 1}`) : undefined,
  };
}

/** The ID for the next completed copy of a repeating task, skipping any already taken. */
export function cloneId(id: string, fields: Fields, taken: (id: string) => boolean) {
  let n = int(fields, "next-clone-identifier") ?? 0;
  while (taken(`${id}.${n}`)) n++;
  return { id: `${id}.${n}`, next: n + 1 };
}

/** A rank between the original's and the next sibling up, as OmniFocus places clones. */
export function cloneRank(rank: number, siblingRanks: number[]) {
  const below = siblingRanks.filter((r) => r < rank);
  const prev = below.length ? Math.max(...below) : Math.max(rank - 2 ** 25, -(2 ** 31));
  return Math.ceil((prev + rank) / 2);
}
