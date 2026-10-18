import { createHash } from "crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { DateTime } from "luxon";
import * as plist from "plist";
import debug from "debug";
import { nonNullable } from "@/utils";
import { DocumentKey } from "./crypto";
import { bool, Database, Fields, idref, int, parseTransaction, ParsedTransaction, text } from "./database";
import { cloneId, cloneRank, nextDates, repetitionOf, shiftDates } from "./repeat";
import { Model } from "./model";
import { WebDav } from "./webdav";
import { completeProjectXml, completeTaskXml, createId, escapeXml, fieldsXml, noteXml, rankAfter, NewTask, newTaskXml, tagJoinXml, tagRanksAfter, timestamp, transactionXml } from "./writer";

export * from "./model";
export { describePerspective, findPerspective, perspectiveFilter } from "./perspectives";
export type { Perspective } from "./perspectives";
export { taskDate, rankAfter } from "./writer";

export interface TaskChanges {
  name?: string;
  /** Null or empty clears it. */
  note?: string | null;
  flagged?: boolean;
  /** Already formatted with taskDate(); null clears it. */
  due?: string | null;
  defer?: string | null;
  planned?: string | null;
  estimatedMinutes?: number | null;
  /** Tag IDs: a new set, and/or ones to add and remove. */
  tags?: { set?: string[]; add?: string[]; remove?: string[] };
  /** Moves a task: into a project or under another task, or to the inbox if null. */
  parentId?: string | null;
  /** Moves a project: into a folder, or to the top level if null. */
  folderId?: string | null;
  type?: "sequential" | "parallel" | "single_actions";
  completeWithLastAction?: boolean;
}

const DEBUG = debug("services:clients:omnifocus");

const TRANSACTION = /^(\d{14})=([^.]+)\.zip$/;
const BASELINE_STAMP = "00000000000000";
const DOWNLOAD_CONCURRENCY = 8;
// The order OmniFocus writes a task's fields in.
const TASK_FIELD_ORDER = [
  "project", "inbox", "task", "added", "name", "note", "rank", "hidden", "context", "start", "planned", "due",
  "completed", "estimated-minutes", "order", "flagged", "completed-by-children", "repetition-rule", "repetition-method",
  "repetition-schedule-type", "repetition-anchor-date", "catch-up-automatically", "next-clone-identifier",
  "due-date-alarm-policy", "defer-date-alarm-policy", "latest-time-to-start-alarm-policy", "planned-date-alarm-policy",
];
const FIELD_DEFAULTS: Record<string, string> = {
  inbox: "false",
  flagged: "false",
  "completed-by-children": "false",
  "catch-up-automatically": "false",
};
// Keep our client registration current so we don't hold back compaction, without writing on every read.
const REGISTRATION_REFRESH_MS = 15 * 60 * 1000;
// Used when there are no other clients to copy from.
const DEFAULT_CLIENT: Record<string, plist.PlistValue> = {
  ApplicationMarketingVersion: "4.8",
  CurrentFrameworkVersion: "2",
  OFMSyncClientModelVersion: "6.0.18",
  OFMSyncClientSupportedCapabilities: ["delta_transactions"],
  XMLSyncClientSupportedCapabilities: [
    "stable_repeats",
    "external_attachments",
    "floating_time_zones",
    "unknown_element_import",
    "versioned_perspectives",
    "delta_transactions",
    "active_object_hidden_dates",
  ],
  bundleIdentifier: "com.omnigroup.OmniFocus4",
  bundleVersion: "185.9.1",
};

interface Transaction {
  name: string;
  stamp: string;
  parents: string[];
  tail: string;
}

function parseTransactionName(name: string): Transaction | null {
  const match = name.match(TRANSACTION);
  if (!match) return null;
  const ids = match[2].split("+");
  return { name, stamp: match[1], parents: ids.slice(0, -1), tail: ids[ids.length - 1] };
}

function utcStamp(d = DateTime.utc()) {
  return d.toUTC().toFormat("yyyyMMddHHmmss");
}

/**
 * The order to apply transactions in: the current baseline, then each transaction once all of its parents have been
 * applied. Transactions which don't descend from the baseline (e.g. leftovers from a compaction) are skipped.
 */
function transactionOrder(transactions: Transaction[]): Transaction[] {
  const baselines = transactions.filter((t) => t.stamp === BASELINE_STAMP);
  if (baselines.length === 0) throw new Error("The OmniFocus database has no baseline transaction.");
  // Compaction writes a new baseline descending from what it compacted, so prefer one whose parent is known.
  const tails = new Set(transactions.map((t) => t.tail));
  const baseline =
    baselines.filter((b) => b.parents.some((p) => tails.has(p))).sort((a, b) => a.name.localeCompare(b.name)).pop() ??
    baselines.sort((a, b) => a.name.localeCompare(b.name)).pop()!;

  // The baseline stands in for everything it compacted, so transactions written against its parent still apply.
  const applied = new Set([baseline.tail, ...baseline.parents]);
  const order = [baseline];
  const pending = transactions.filter((t) => t.stamp !== BASELINE_STAMP).sort((a, b) => a.name.localeCompare(b.name));
  for (let progress = true; progress; ) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      if (applied.has(t.tail) || !t.parents.every((p) => applied.has(p))) continue;
      order.push(t);
      applied.add(t.tail);
      pending.splice(i, 1);
      progress = true;
      break;
    }
  }
  return order;
}

/** Tails no applied transaction builds on: the latest state of each branch of history, newest last. */
function headsOf(order: Transaction[]): string[] {
  const [baseline, ...rest] = order;
  const parents = new Set(rest.flatMap((t) => t.parents));
  const heads = rest.filter((t) => !parents.has(t.tail)).map((t) => t.tail);
  // Transactions can build on the baseline by its own ID or by any it stands in for.
  const builtOn = [baseline.tail, ...baseline.parents].some((id) => parents.has(id));
  return builtOn ? heads : [baseline.tail, ...heads];
}

function parsePlist(data: Buffer): Record<string, plist.PlistValue> {
  const value = data.subarray(0, 6).toString("latin1") === "bplist" ? plist.parseBinary(data) : plist.parse(data.toString("utf8"));
  return (Array.isArray(value) ? value[0] : value) as Record<string, plist.PlistValue>;
}

export interface OmniFocusOptions {
  username: string;
  password: string;
  /** Defaults to the account password, as OmniFocus does. */
  passphrase?: string;
  server?: string;
  database?: string;
  /** Time zone for floating dates. */
  zone: string;
  /** Shown as this device's name in OmniFocus's sync settings. */
  clientName: string;
}

/**
 * Reads and writes an OmniFocus database through the Omni Sync Server, the same way the OmniFocus apps do: the
 * database is a WebDAV folder of encrypted, zipped XML transactions, and changes are new transactions.
 */
export class OmniFocus {
  private dav: WebDav;
  private url: string;
  private key: DocumentKey | null | undefined;
  private clientId: string;
  private hostId: string;

  private cache = new Map<string, ParsedTransaction>();
  private db = new Database();
  private applied: string[] = [];
  private heads: string[] = [];
  private registration: { at: number; tails: string[] } | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private options: OmniFocusOptions) {
    this.dav = new WebDav(options.username, options.password);
    const server = (options.server ?? "https://sync.omnigroup.com").replace(/\/+$/, "");
    this.url = `${server}/${encodeURIComponent(options.username)}/${options.database ?? "OmniFocus.ofocus"}/`;
    // Stable across restarts, so this service is always the same sync client.
    const seed = `services:${options.username}:${options.clientName}`;
    this.clientId = createId(seed);
    const hash = createHash("sha256").update(`${seed}:host`).digest("hex").toUpperCase();
    this.hostId = [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join("-");
  }

  /** Runs operations one at a time, so a write always builds on the latest sync. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private fileUrl(name: string) {
    return this.url + encodeURIComponent(name);
  }

  private async download(name: string): Promise<ParsedTransaction> {
    let data = await this.dav.get(this.fileUrl(name));
    if (this.key) data = this.key.decrypt(name, data);
    const files = unzipSync(new Uint8Array(data), { filter: (f) => f.name === "contents.xml" });
    if (!files["contents.xml"]) throw new Error(`${name} has no contents.xml.`);
    return parseTransaction(strFromU8(files["contents.xml"]));
  }

  private async syncUnlocked(): Promise<{ model: Model; clients: string[] }> {
    const listing = await this.dav.list(this.url);
    this.url = listing.url.endsWith("/") ? listing.url : `${listing.url}/`; // Skip the shard redirect from now on
    const names = listing.entries.filter((e) => !e.isCollection).map((e) => e.name);

    if (this.key === undefined) {
      this.key = names.includes("encrypted")
        ? await DocumentKey.unlock(await this.dav.get(this.fileUrl("encrypted")), this.options.passphrase ?? this.options.password)
        : null;
    }

    const order = transactionOrder(names.map(parseTransactionName).filter(nonNullable));
    const missing = order.filter((t) => !this.cache.has(t.name));
    if (missing.length) DEBUG(`Downloading ${missing.length} transactions.`);
    for (let i = 0; i < missing.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = missing.slice(i, i + DOWNLOAD_CONCURRENCY);
      const parsed = await Promise.all(batch.map((t) => this.download(t.name)));
      batch.forEach((t, j) => this.cache.set(t.name, parsed[j]));
    }
    const current = new Set(order.map((t) => t.name));
    for (const name of this.cache.keys()) if (!current.has(name)) this.cache.delete(name);

    // Transactions never change, so if history only grew, just apply what's new.
    const orderNames = order.map((t) => t.name);
    const grew = this.applied.length > 0 && this.applied.every((name, i) => orderNames[i] === name);
    if (!grew) this.db = new Database();
    for (const name of orderNames.slice(grew ? this.applied.length : 0)) this.db.apply(this.cache.get(name)!);
    this.applied = orderNames;
    this.heads = headsOf(order);

    const clients = names.filter((n) => n.endsWith(".client"));
    return { model: new Model(this.db, DateTime.now().setZone(this.options.zone), this.options.zone), clients };
  }

  /** Syncs with the server and returns the current state of the database. */
  sync(): Promise<Model> {
    return this.exclusive(async () => {
      const { model, clients } = await this.syncUnlocked();
      // Registered before a restart, so keep that registration current too.
      if (!this.registration && clients.some((n) => n.endsWith(`=${this.clientId}.client`)))
        this.registration = { at: 0, tails: [] };
      const stale =
        this.registration &&
        Date.now() - this.registration.at > REGISTRATION_REFRESH_MS &&
        this.registration.tails.join("+") !== this.heads.join("+");
      if (stale) await this.register(clients).catch((ex) => DEBUG(`Couldn't refresh client registration: ${ex}`));
      return model;
    });
  }

  /**
   * Registers this service as a sync client, with the transactions it has seen. OmniFocus only compacts history all
   * clients have seen, and uses registrations to tell live clients from ones it can forget.
   */
  private async register(clients: string[]) {
    const ours = clients.filter((n) => n.endsWith(`=${this.clientId}.client`)).sort();
    const others = clients.filter((n) => !ours.includes(n)).sort();
    const read = async (name: string) => {
      let data = await this.dav.get(this.fileUrl(name));
      if (this.key) data = this.key.decrypt(name, data);
      return parsePlist(data);
    };

    // Copy the newest real client's versions and capabilities, so we claim to understand what it writes.
    let template = DEFAULT_CLIENT;
    if (others.length) {
      try {
        const other = await read(others[others.length - 1]);
        template = Object.fromEntries(
          Object.entries(other).filter(([k]) => !/^(Hardware|OS)/.test(k) && k !== "tailIdentifiers"),
        );
      } catch (ex) {
        DEBUG(`Couldn't read ${others[others.length - 1]}: ${ex}`);
      }
    }
    let registrationDate = new Date();
    if (ours.length) {
      try {
        const existing = (await read(ours[ours.length - 1])).registrationDate;
        if (existing instanceof Date) registrationDate = existing;
      } catch {}
    }

    const now = new Date();
    const name = `${utcStamp()}=${this.clientId}.client`;
    const body = plist.build({
      ...template,
      clientIdentifier: this.clientId,
      hostID: this.hostId,
      name: this.options.clientName,
      registrationDate,
      lastSyncDate: now,
      tailIdentifiers: this.heads,
    });
    const data = Buffer.from(body, "utf8");
    await this.dav.put(this.fileUrl(name), this.key ? this.key.encrypt(name, data) : data);
    for (const old of ours) if (old !== name) await this.dav.delete(this.fileUrl(old));
    this.registration = { at: now.getTime(), tails: [...this.heads] };
  }

  /** Writes a transaction of the given elements, built from the latest state of the database. */
  private write(build: (model: Model) => string[]): Promise<Model> {
    return this.exclusive(async () => {
      const { model, clients } = await this.syncUnlocked();
      const elements = build(model);
      const parent = this.heads[this.heads.length - 1];
      const head = this.applied[this.applied.length - 1];
      // Names sort chronologically, so never go before the transaction we're building on.
      const stamp = [utcStamp(), parseTransactionName(head)!.stamp].sort().pop()!;
      const tail = createId();
      const name = `${stamp}=${parent}+${tail}.zip`;

      const xml = transactionXml(elements, {
        id: String(DEFAULT_CLIENT.bundleIdentifier),
        version: String(DEFAULT_CLIENT.bundleVersion),
      });
      const transaction = parseTransaction(xml);
      const zip = Buffer.from(zipSync({ "contents.xml": strToU8(xml) }));
      await this.dav.put(this.fileUrl(name), this.key ? this.key.encrypt(name, zip) : zip);
      DEBUG(`Wrote ${name}.`);

      this.cache.set(name, transaction);
      this.db.apply(transaction);
      this.applied.push(name);
      this.heads = [...this.heads.filter((h) => h !== parent), tail];
      await this.register(clients).catch((ex) => DEBUG(`Couldn't register client: ${ex}`));
      return new Model(this.db, DateTime.now().setZone(this.options.zone), this.options.zone);
    });
  }

  /** Adds a task, returning its ID and the updated database. */
  async addTask(task: Omit<NewTask, "rank"> & { rank?: (model: Model) => number }) {
    const id = createId();
    const model = await this.write((m) => newTaskXml(id, { ...task, rank: task.rank?.(m) ?? 0 }));
    return { id, model };
  }

  /**
   * Marks tasks complete as OmniFocus does: along with any of their subtasks which aren't already, and their parent if
   * it's set to complete with its last subtask. A repeating task is instead moved to its next repetition, with a
   * completed copy left behind. Checks each task against the latest sync with `check`, which should throw if it can't
   * be completed.
   */
  async completeTasks(ids: string[], check: (model: Model, id: string) => void) {
    const alsoCompleted: string[] = [];
    const model = await this.write((model) => {
      for (const id of ids) check(model, id);
      return this.completionXml(model, ids, DateTime.utc(), alsoCompleted);
    });
    return { model, alsoCompleted };
  }

  /**
   * Changes fields on a task or project, as an update containing only what changed, the way OmniFocus records edits.
   * Checks the task against the latest sync with `check`, which should throw if the edit isn't allowed.
   */
  async editTask(id: string, changes: TaskChanges, check: (model: Model) => void) {
    return this.write((model) => {
      check(model);
      return this.editXml(model, id, changes);
    });
  }

  private editXml(model: Model, id: string, changes: TaskChanges): string[] {
    const fields = this.db.tasks.get(id);
    const task = model.tasks.get(id);
    if (!fields || !task) throw new Error(`No OmniFocus task with ID ${id}.`);
    const now = timestamp();
    const set: Record<string, string> = { modified: `<modified>${now}</modified>` };
    const elements: string[] = [];
    const touch = (parentId: string | null) => {
      if (parentId && parentId !== id && !elements.some((e) => e.startsWith(`<task id="${parentId}" `)))
        elements.push(`<task id="${parentId}" op="update"><modified>${now}</modified></task>`);
    };
    const date = (field: string, value: string | null) => (value ? `<${field}>${value}</${field}>` : `<${field}/>`);

    if (changes.name !== undefined) set.name = `<name>${escapeXml(changes.name)}</name>`;
    if (changes.note !== undefined) set.note = changes.note ? noteXml(changes.note) : "<note/>";
    if (changes.flagged !== undefined) set.flagged = `<flagged>${changes.flagged}</flagged>`;
    if (changes.due !== undefined) set.due = date("due", changes.due);
    if (changes.defer !== undefined) set.start = date("start", changes.defer);
    if (changes.planned !== undefined) set.planned = date("planned", changes.planned);
    if (changes.estimatedMinutes !== undefined)
      set["estimated-minutes"] = date("estimated-minutes", changes.estimatedMinutes ? String(changes.estimatedMinutes) : null);
    if (changes.completeWithLastAction !== undefined)
      set["completed-by-children"] = `<completed-by-children>${changes.completeWithLastAction}</completed-by-children>`;

    // Projects keep their folder and single-action setting in <project>, which OmniFocus restates whole.
    if (task.isProject && (changes.folderId !== undefined || changes.type !== undefined)) {
      const project = { ...(fields.project as Fields) };
      if (changes.folderId !== undefined) project.folder = changes.folderId ? { "@_idref": changes.folderId } : "";
      if (changes.type !== undefined) project.singleton = String(changes.type === "single_actions");
      set.project = fieldsXml({ project });
    }
    if (changes.type !== undefined && changes.type !== "single_actions") set.order = `<order>${changes.type}</order>`;

    if (changes.parentId !== undefined) {
      const parent = changes.parentId;
      const siblings = [...this.db.tasks]
        .filter(([sid, f]) => sid !== id && (parent ? idref(f, "task") === parent : bool(f, "inbox") && !idref(f, "task")))
        .map(([, f]) => int(f, "rank") ?? 0);
      set.inbox = `<inbox>${!parent}</inbox>`;
      set.task = parent ? `<task idref="${parent}"/>` : "<task/>";
      set.rank = `<rank>${rankAfter(siblings)}</rank>`;
      touch(idref(fields, "task"));
      touch(parent);
    }

    if (changes.tags) {
      const current = task.tagIds;
      let next = changes.tags.set ?? current;
      next = [...new Set([...next, ...(changes.tags.add ?? [])])].filter((t) => !changes.tags!.remove?.includes(t));
      const joins = [...this.db.objects["task-to-tag"]].filter(([, j]) => idref(j, "task") === id);
      for (const [joinId, j] of joins)
        if (!next.includes(idref(j, "context") ?? "")) elements.push(`<task-to-tag id="${joinId}" op="delete"/>`);
      const adding = next.filter((tagId) => !joins.some(([, j]) => idref(j, "context") === tagId));
      const ranks = tagRanksAfter(joins.map(([, j]) => text(j, "rank-in-task") ?? ""), adding.length);
      adding.forEach((tagId, i) => elements.push(tagJoinXml(id, tagId, ranks[i], now)));
      // The first tag is also the task's primary tag, which older clients read.
      if ((idref(fields, "context") ?? null) !== (next[0] ?? null))
        set.context = next.length ? `<context idref="${next[0]}"/>` : "<context/>";
    }

    const order = ["project", "inbox", "task", "modified", ...TASK_FIELD_ORDER.filter((k) => !["project", "inbox", "task"].includes(k))];
    elements.unshift(`<task id="${id}" op="update">${order.filter((k) => set[k]).map((k) => set[k]).join("")}</task>`);
    return elements;
  }

  /**
   * The elements which complete the given tasks, as completeTasks() describes. Adds parents completed along with them
   * to `alsoCompleted`.
   */
  private completionXml(model: Model, ids: string[], when: DateTime, alsoCompleted: string[] = []): string[] {
    const completing = new Map<string, DateTime>();
    const repeating: string[] = [];
    const complete = (id: string) => {
      for (const t of model.descendants(id)) if (t.status === "remaining") completing.set(t.id, when);
    };
    const done = (id: string) => completing.has(id) || model.tasks.get(id)!.status !== "remaining";
    const cascade = (id: string) => {
      const parent = model.tasks.get(model.tasks.get(id)!.parentId ?? "");
      if (!parent || done(parent.id) || repeating.includes(parent.id)) return;
      const fields = this.db.tasks.get(parent.id)!;
      if (!bool(fields, "completed-by-children") || !parent.childIds.every(done)) return;
      if (parent.isProject) {
        // Single-action lists are never done, and repeating projects would need their whole contents copied.
        if (bool(fields.project as Fields, "singleton") || repetitionOf(fields)) return;
        completing.set(parent.id, when);
        alsoCompleted.push(parent.id);
      } else if (repetitionOf(fields)) {
        repeating.push(parent.id);
        alsoCompleted.push(parent.id);
      } else {
        completing.set(parent.id, when);
        alsoCompleted.push(parent.id);
        cascade(parent.id);
      }
    };

    for (const id of ids) {
      if (repetitionOf(this.db.tasks.get(id)!)) repeating.push(id);
      else complete(id);
    }
    for (const id of [...completing.keys()]) cascade(id);

    const elements: string[] = [];
    // Subtasks whose completion is recorded on their repeating parent's copy instead.
    const absorbed = new Set<string>();
    for (const id of repeating) {
      const xml = this.repeatXml(model, id, when, completing, absorbed);
      if (xml) elements.push(...xml);
      else complete(id); // The repeat has ended
    }
    for (const [id, at] of completing) {
      if (absorbed.has(id)) continue;
      const fields = this.db.tasks.get(id)!;
      elements.push(
        typeof fields.project === "object"
          ? completeProjectXml(id, fields.project as Fields, at)
          : completeTaskXml(id, at),
      );
    }
    return elements;
  }

  /** A full copy of a task for a repetition's completed copy, in the order OmniFocus writes fields. */
  private copyXml(id: string, fields: Fields, overrides: Fields) {
    const { modified, ...copy } = fields;
    const all: Fields = {
      // OmniFocus writes every field it knows about, so older tasks' copies gain them, empty or at their defaults.
      ...Object.fromEntries(TASK_FIELD_ORDER.filter((k) => k !== "order").map((k) => [k, FIELD_DEFAULTS[k] ?? ""])),
      ...copy,
      note: typeof copy.note === "string" ? copy.note.trim() : (copy.note ?? ""),
      added: timestamp(),
      "next-clone-identifier": "0",
      ...overrides,
    };
    const order = [...TASK_FIELD_ORDER.filter((k) => k in all), ...Object.keys(all).filter((k) => !TASK_FIELD_ORDER.includes(k))];
    return `<task id="${id}">${fieldsXml(Object.fromEntries(order.map((k) => [k, all[k]])))}</task>`;
  }

  private tagCopiesXml(from: string, to: string) {
    return [...this.db.objects["task-to-tag"].values()]
      .filter((j) => idref(j, "task") === from && idref(j, "context"))
      .map((j) => tagJoinXml(to, idref(j, "context")!, text(j, "rank-in-task") ?? ""));
  }

  /**
   * Completes one repetition of a repeating task the way OmniFocus does (see repeat.ts), or returns null if the repeat
   * has ended. Subtasks being completed in the same transaction are recorded on their copies and added to `absorbed`.
   */
  private repeatXml(model: Model, id: string, when: DateTime, completing: Map<string, DateTime>, absorbed: Set<string>) {
    const fields = this.db.tasks.get(id)!;
    const repetition = repetitionOf(fields)!;
    const { dates, repeats, shift, rule } = nextDates(fields, repetition, when, this.options.zone);
    if (!repeats) return null;
    const now = timestamp();
    const parent = idref(fields, "task");
    const siblingRanks = [...this.db.tasks.values()]
      .filter((f) => idref(f, "task") === parent && (parent || bool(f, "inbox")))
      .map((f) => int(f, "rank") ?? 0);
    const taken = (c: string) => this.db.tasks.has(c);
    const clone = cloneId(id, fields, taken);
    const elements = [
      ...(parent ? [`<task id="${parent}" op="update"><modified>${now}</modified></task>`] : []),
      `<task id="${id}" op="update"><modified>${now}</modified>` +
        Object.entries(dates).map(([k, v]) => `<${k}>${v}</${k}>`).join("") +
        (rule
          ? `<repetition-rule>${escapeXml(rule)}</repetition-rule>` +
            `<repetition-schedule-type>${repetition.scheduleType}</repetition-schedule-type>` +
            `<repetition-anchor-date>${repetition.anchor}</repetition-anchor-date>`
          : "") +
        `<next-clone-identifier>${clone.next}</next-clone-identifier></task>`,
      this.copyXml(clone.id, fields, {
        rank: String(cloneRank(int(fields, "rank") ?? 0, siblingRanks)),
        completed: timestamp(when),
        "repetition-method": repetition.method,
        "repetition-schedule-type": repetition.scheduleType,
        "repetition-anchor-date": repetition.anchor,
        "catch-up-automatically": String(repetition.catchUp),
      }),
      ...this.tagCopiesXml(id, clone.id),
    ];

    // Subtasks are copied under the copy, and reset for the next repetition.
    const copySubtasks = (taskId: string, copyId: string) => {
      for (const child of model.tasks.get(taskId)!.childIds) {
        const childFields = this.db.tasks.get(child)!;
        const childClone = cloneId(child, childFields, taken);
        const completedAt = completing.has(child) ? timestamp(completing.get(child)!) : text(childFields, "completed");
        if (completing.has(child)) absorbed.add(child);
        elements.push(
          `<task id="${child}" op="update"><modified>${now}</modified>` +
            (text(childFields, "completed") ? "<completed/>" : "") +
            Object.entries(shiftDates(childFields, shift, this.options.zone)).map(([k, v]) => `<${k}>${v}</${k}>`).join("") +
            `<next-clone-identifier>${childClone.next}</next-clone-identifier></task>`,
          this.copyXml(childClone.id, childFields, { task: { "@_idref": copyId }, completed: completedAt ?? "" }),
          ...this.tagCopiesXml(child, childClone.id),
        );
        copySubtasks(child, childClone.id);
      }
    };
    copySubtasks(id, clone.id);
    return elements;
  }
}
