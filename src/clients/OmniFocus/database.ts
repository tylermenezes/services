import { XMLParser } from "fast-xml-parser";

// Reconstructs an OmniFocus database from its XML transactions. Format notes:
// https://github.com/tomzx/ofocus-format, https://github.com/jyruzicka/rubyfocus, https://github.com/kumpelblase2/focus
//
// Each transaction's contents.xml holds a list of objects. An object with no `op` is created (replacing any existing
// object with that ID); `op="update"` changes only the child elements it includes, and an empty element clears that
// field; `op="delete"` removes it; and `op="reference"` is a copy of an unchanged object for context, so it's ignored.

const OBJECT_TYPES = ["task", "context", "folder", "task-to-tag", "setting", "perspective"] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

/** An object's child elements, as parsed: a string for text, an object for attributes (e.g. `{ "@_idref": "…" }`). */
export type Fields = Record<string, unknown>;

export interface ParsedTransaction {
  objects: { type: ObjectType; id: string; op: "create" | "update" | "delete" | "reference"; fields: Fields }[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  // Notes are rich text; keep their raw XML so noteText() can pull out just the text. Perspectives' plists are kept raw
  // too, since this parser can't keep a plist dictionary's keys paired with their values.
  stopNodes: [...OBJECT_TYPES.map((t) => `omnifocus.${t}.note`), "omnifocus.perspective.plist"],
  isArray: (_, jpath) => OBJECT_TYPES.some((t) => jpath === `omnifocus.${t}`),
});

export function parseTransaction(xml: string): ParsedTransaction {
  const root = parser.parse(xml)?.omnifocus ?? {};
  const objects: ParsedTransaction["objects"] = [];
  for (const type of OBJECT_TYPES) {
    for (const el of (root[type] ?? []) as (Fields | string)[]) {
      if (typeof el !== "object" || !el["@_id"]) continue;
      const { "@_id": id, "@_op": op, ...fields } = el;
      for (const k of Object.keys(fields)) if (k.startsWith("@_")) delete fields[k];
      objects.push({
        type,
        id: String(id),
        op: op === "update" || op === "delete" || op === "reference" ? op : "create",
        fields,
      });
    }
  }
  return { objects };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1)))
      : (ENTITIES[e] ?? m),
  );
}

/** Plain text of a rich-text note (`<text><p><run><lit>…</lit></run></p></text>`), or of an older plain one. */
export function noteText(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (!/<(p|lit)\b/.test(raw)) return decodeEntities(raw.replace(/<[^>]*>/g, "")).trim() || null;
  const paragraphs = [...raw.matchAll(/<p\b[^>]*?(?:\/>|>([\s\S]*?)<\/p>)/g)].map(([, inner]) =>
    [...(inner ?? "").matchAll(/<lit\b[^>]*>([\s\S]*?)<\/lit>/g)].map(([, t]) => decodeEntities(t)).join(""),
  );
  return paragraphs.join("\n").trim() || null;
}

/** Text of a child element, or null if it's missing or empty. */
export function text(fields: Fields, name: string): string | null {
  const v = fields[name];
  if (typeof v === "string") return v === "" ? null : v;
  if (v && typeof v === "object" && "#text" in v) return String((v as Fields)["#text"]) || null;
  return null;
}

/** The `idref` of a reference element like `<task idref="…"/>`, or null. */
export function idref(fields: Fields, name: string): string | null {
  const v = fields[name];
  return v && typeof v === "object" && "@_idref" in v ? String((v as Fields)["@_idref"]) : null;
}

export function bool(fields: Fields, name: string): boolean {
  return text(fields, name) === "true";
}

export function int(fields: Fields, name: string): number | null {
  const t = text(fields, name);
  if (t === null) return null;
  const n = Number.parseInt(t);
  return Number.isNaN(n) ? null : n;
}

/** Applies an update to an object's fields. `<project>` is itself updated piecewise, and an empty one demotes it. */
function merge(existing: Fields, update: Fields): Fields {
  const merged = { ...existing, ...update };
  if ("project" in update && typeof update.project === "object" && typeof existing.project === "object")
    merged.project = { ...(existing.project as Fields), ...(update.project as Fields) };
  return merged;
}

export class Database {
  readonly objects: Record<ObjectType, Map<string, Fields>> = Object.fromEntries(
    OBJECT_TYPES.map((t) => [t, new Map()]),
  ) as any;

  apply(transaction: ParsedTransaction) {
    for (const { type, id, op, fields } of transaction.objects) {
      const map = this.objects[type];
      if (op === "reference") continue;
      else if (op === "delete") map.delete(id);
      else if (op === "update") {
        // An update to something we don't have (e.g. replayed after a compaction already deleted it) can't be applied.
        if (map.has(id)) map.set(id, merge(map.get(id)!, fields));
      } else map.set(id, fields);
    }
  }

  get tasks() {
    return this.objects.task;
  }
  get tags() {
    return this.objects.context;
  }
  get folders() {
    return this.objects.folder;
  }

  /** Tag IDs for each task ID, from task-to-tag joins and the task's primary tag. */
  taskTags(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const add = (task: string, tag: string) => {
      const tags = result.get(task) ?? [];
      if (!tags.includes(tag)) tags.push(tag);
      result.set(task, tags);
    };
    for (const [id, fields] of this.tasks) {
      const primary = idref(fields, "context");
      if (primary) add(id, primary);
    }
    for (const fields of this.objects["task-to-tag"].values()) {
      const [task, tag] = [idref(fields, "task"), idref(fields, "context")];
      if (task && tag) add(task, tag);
    }
    return result;
  }
}
