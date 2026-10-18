import { createHash, randomBytes } from "crypto";
import { DateTime } from "luxon";
import { Fields } from "./database";

const NAMESPACE = "http://www.omnigroup.com/namespace/OmniFocus/v2";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const MAX_RANK = 2 ** 31 - 1;

/** An 11-character OmniFocus ID encoding 64 bits, as in OmniFoundation's OFXMLCreateID. Random unless seeded. */
export function createId(seed?: string): string {
  const bytes = seed ? createHash("sha256").update(seed).digest() : randomBytes(8);
  let value = bytes.readBigUInt64LE(0);
  // The first character only encodes 4 bits, so it's always a letter, as XML IDs require.
  let id = ID_ALPHABET[Number(value & 0xfn)];
  value >>= 4n;
  for (let i = 1; i < 11; i++, value >>= 6n) id += ID_ALPHABET[Number(value & 0x3fn)];
  return id;
}

export function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A timestamp as OmniFocus writes them for added, modified, and completed: UTC, with milliseconds. */
export function timestamp(d: DateTime = DateTime.utc()) {
  return d.toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}

/**
 * Converts a user-supplied ISO 8601 date for a due or defer date. A time with an offset is stored as that exact
 * moment; one without is stored as a floating local time, as OmniFocus does. A bare date gets the default time.
 */
export function taskDate(input: string, defaultTime: string, zone: string): string {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(input.trim()) ? `${input.trim()}T${defaultTime}` : input.trim();
  const hasOffset = /T.*([zZ]|[+-]\d{2}(:?\d{2})?)$/.test(value);
  const dt = DateTime.fromISO(value, { zone });
  if (!dt.isValid) throw new Error(`Invalid date: ${input}. Use ISO 8601, e.g. 2026-10-20 or 2026-10-20T15:00.`);
  return hasOffset ? timestamp(dt) : dt.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
}

/** A rank after the given siblings' ranks, so a new task goes to the end of its list. */
export function rankAfter(siblingRanks: number[]) {
  if (siblingRanks.length === 0) return 0;
  const max = Math.max(...siblingRanks);
  return max + 2 ** 20 <= MAX_RANK ? max + 2 ** 20 : Math.floor((max + MAX_RANK) / 2);
}

/** A note as OmniFocus rich text, with a paragraph per line. */
export function noteXml(note: string) {
  const paragraphs = note.split(/\r?\n/).map((line) => `<p><run><lit>${escapeXml(line)}</lit></run></p>`);
  return `<note><text>${paragraphs.join("")}</text></note>`;
}

export function transactionXml(elements: string[], app: { id: string; version: string }) {
  return (
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>\n' +
    `<omnifocus xmlns="${NAMESPACE}" app-id="${escapeXml(app.id)}" app-version="${escapeXml(app.version)}">\n` +
    elements.map((e) => `  ${e}\n`).join("") +
    "</omnifocus>\n"
  );
}

export interface NewTask {
  name: string;
  note?: string;
  /** A project or task to put this in; the inbox if unset. */
  parentId?: string;
  tagIds: string[];
  /** Already formatted with taskDate(). */
  due?: string;
  defer?: string;
  planned?: string;
  flagged?: boolean;
  estimatedMinutes?: number;
  rank: number;
}

/** The elements which create a task, and its tag assignments. Every field is given, as OmniFocus writes them. */
export function newTaskXml(id: string, task: NewTask): string[] {
  const now = timestamp();
  const parts = [
    `<task id="${id}">`,
    "<project/>",
    task.parentId ? `<inbox>false</inbox><task idref="${task.parentId}"/>` : "<inbox>true</inbox><task/>",
    `<added>${now}</added>`,
    `<name>${escapeXml(task.name)}</name>`,
    task.note ? noteXml(task.note) : "<note/>",
    `<rank>${task.rank}</rank>`,
    "<hidden/>",
    task.tagIds.length ? `<context idref="${task.tagIds[0]}"/>` : "<context/>",
    task.defer ? `<start>${task.defer}</start>` : "<start/>",
    task.planned ? `<planned>${task.planned}</planned>` : "<planned/>",
    task.due ? `<due>${task.due}</due>` : "<due/>",
    "<completed/>",
    task.estimatedMinutes ? `<estimated-minutes>${task.estimatedMinutes}</estimated-minutes>` : "<estimated-minutes/>",
    "<order>parallel</order>",
    `<flagged>${task.flagged ? "true" : "false"}</flagged>`,
    "<completed-by-children>false</completed-by-children>",
    "<repetition-rule/><repetition-method/><repetition-schedule-type/><repetition-anchor-date/>",
    "<catch-up-automatically>false</catch-up-automatically>",
    "<next-clone-identifier>0</next-clone-identifier>",
    "<due-date-alarm-policy/><defer-date-alarm-policy/><latest-time-to-start-alarm-policy/><planned-date-alarm-policy/>",
    "</task>",
  ];
  const ranks = tagRanksAfter([], task.tagIds.length);
  return [parts.join(""), ...task.tagIds.map((tagId, i) => tagJoinXml(id, tagId, ranks[i], now))];
}

/**
 * Keys ordering a task's tags, after the ones it already has. OmniFocus uses short hex strings compared as text (it
 * gave a task's only tag "0da4"); how it picks them isn't known, so these just keep to that shape.
 */
export function tagRanksAfter(existing: string[], count: number): string[] {
  const last = existing.filter((r) => /^[0-9a-f]+$/.test(r)).sort().pop();
  let next = last ? Number.parseInt(last.slice(0, 4).padEnd(4, "0"), 16) + 0x1000 : 0x1000;
  const ranks: string[] = [];
  for (let i = 0; i < count; i++, next += 0x1000)
    ranks.push(next <= 0xffff ? next.toString(16).padStart(4, "0") : `${last ?? "ffff"}${"8".repeat(i + 1)}`);
  return ranks;
}

/** A tag assignment, which OmniFocus identifies as `<task id>.<tag id>`. */
export function tagJoinXml(taskId: string, tagId: string, rankInTask: string, added = timestamp()) {
  return (
    `<task-to-tag id="${taskId}.${tagId}"><added>${added}</added><task idref="${taskId}"/>` +
    `<context idref="${tagId}"/><rank-in-task>${rankInTask}</rank-in-task><rank-in-tag/></task-to-tag>`
  );
}

/** Serializes parsed fields back to XML. Notes are kept as the raw rich text they were parsed as. */
export function fieldsXml(fields: Fields): string {
  const element = (name: string, value: unknown): string => {
    if (Array.isArray(value)) return value.map((v) => element(name, v)).join("");
    if (typeof value !== "object" || value === null) {
      const content = String(value ?? "");
      if (content === "") return `<${name}/>`;
      return `<${name}>${name === "note" ? content : escapeXml(content)}</${name}>`;
    }
    const entries = Object.entries(value as Fields);
    const attrs = entries.filter(([k]) => k.startsWith("@_")).map(([k, v]) => ` ${k.slice(2)}="${escapeXml(String(v))}"`);
    const inner =
      String((value as Fields)["#text"] ?? "") === "" ? "" : escapeXml(String((value as Fields)["#text"]));
    const children = fieldsXml(Object.fromEntries(entries.filter(([k]) => !k.startsWith("@_") && k !== "#text")));
    return inner || children ? `<${name}${attrs.join("")}>${inner}${children}</${name}>` : `<${name}${attrs.join("")}/>`;
  };
  return Object.entries(fields).map(([k, v]) => element(k, v)).join("");
}

/** The element which marks an existing task complete. */
export function completeTaskXml(id: string, when: DateTime) {
  return `<task id="${id}" op="update"><modified>${timestamp()}</modified><completed>${timestamp(when)}</completed></task>`;
}

/**
 * The element which marks a project complete. OmniFocus restates a project's whole <project> block when it changes, so
 * this does too, rather than relying on a partial one leaving the folder and review settings alone.
 */
export function completeProjectXml(id: string, project: Fields, when: DateTime) {
  return (
    `<task id="${id}" op="update">${fieldsXml({ project: { ...project, status: "done" } })}` +
    `<modified>${timestamp()}</modified><completed>${timestamp(when)}</completed></task>`
  );
}
