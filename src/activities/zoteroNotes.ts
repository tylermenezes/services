import { createHash } from "crypto";
import { promises as fs } from "fs";
import { dirname, join } from "path";
import debug from "debug";
import config from "@/config";
import { obsidian, zotero, ZoteroItem } from "@/clients";
import { getZoteroRawItem, getZoteroRawItems, onZoteroChange, zoteroReady } from "@/datasources";

const DEBUG = debug("services:activities:zoteroNotes");

const NOTE_DIR = "cite";
// Which note belongs to which Zotero item, and a hash of what was last written to it. Synced with the vault, which
// requires the "unsupported" file type to be enabled in Obsidian Sync (see docker-entrypoint.sh).
const STATE_FILE = join(config.obsidian.vaultDataPath, NOTE_DIR, "zotero-notes.json");
// Written first and moved into place, so a partial file is never synced. Outside the vault, on the same filesystem.
const STATE_TMP_FILE = join(config.obsidian.vaultPath, "zotero-notes.json.tmp");

interface NoteState {
  citeKey: string;
  hash: string;
}

interface NoteContent {
  title: string;
  citation: string;
  abstract: string;
}

let state: Record<string, NoteState> = {};
let queue = Promise.resolve();

/** Note changes run one at a time, so a sync never races another. */
function enqueue(fn: () => Promise<void>) {
  queue = queue.then(fn).catch(DEBUG).then(saveState).catch(DEBUG);
}

async function safely(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (ex) {
    DEBUG(ex);
  }
}

async function loadState() {
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, "utf-8"));
  } catch {
    state = {};
  }
}

async function saveState() {
  await fs.mkdir(dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_TMP_FILE, JSON.stringify(state));
  await fs.rename(STATE_TMP_FILE, STATE_FILE);
}

/** Zotero's citation key field, or the one Better BibTeX pins in Extra. */
function citeKeyOf(item: ZoteroItem): string | null {
  const key =
    (item.data.citationKey as string | undefined)?.trim() ||
    (item.data.extra as string | undefined)?.match(/^\s*Citation Key:\s*(\S+)\s*$/im)?.[1];
  // Characters which aren't allowed in Obsidian note names.
  return key ? key.replace(/[\\/:*?"<>|#^[\]]/g, "-") : null;
}

function notePath(citeKey: string) {
  return `${NOTE_DIR}/&${citeKey}.md`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? entity;
    return String.fromCodePoint(
      code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1)),
    );
  });
}

/** Converts Zotero's HTML citation to markdown. */
function citationMarkdown(html: string) {
  return decodeEntities(
    html
      .replace(/<\/?(i|em)>/g, "*")
      .replace(/<\/?(b|strong)>/g, "**")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function noteContent(item: ZoteroItem): NoteContent {
  const d = item.data;
  return {
    // Some item types name their title field differently.
    title: String(d.title || d.caseName || d.subject || d.nameOfAct || "").trim(),
    citation: citationMarkdown(item.bib || ""),
    abstract: (d.abstractNote || "").toString().trim(),
  };
}

function noteTemplate(note: NoteContent) {
  return `---\npublish: false\n---\n# ${note.title}\n\n## Citation\n${note.citation}\n\n## Abstract\n${note.abstract}\n`;
}

/**
 * Replaces the title, and the contents of the Citation and Abstract sections (up to the next heading), leaving the
 * rest of the note as-is. Missing sections are added to the end.
 */
function updateNote(markdown: string, note: NoteContent) {
  const lines = markdown.replace(/\n$/, "").split("\n");

  // Find headings, skipping frontmatter and code blocks.
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) start = end + 1;
  }
  const headings: { line: number; level: number; text: string }[] = [];
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const fenceMarker = lines[i].match(/^\s*(```|~~~)/)?.[1];
    if (fenceMarker) {
      if (!fence) fence = fenceMarker;
      else if (fenceMarker === fence) fence = null;
    } else if (!fence) {
      const heading = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (heading) headings.push({ line: i, level: heading[1].length, text: heading[2].trim() });
    }
  }

  // Edits are applied bottom-up so earlier line numbers stay valid.
  const edits: { start: number; end: number; lines: string[] }[] = [];
  const appended: string[] = [];

  const title = headings.find((h) => h.level === 1);
  if (title) edits.push({ start: title.line, end: title.line + 1, lines: [`# ${note.title}`] });
  else edits.push({ start, end: start, lines: [`# ${note.title}`, ""] });

  for (const [name, value] of [["Citation", note.citation], ["Abstract", note.abstract]]) {
    const i = headings.findIndex((h) => h.level === 2 && h.text.toLowerCase() === name.toLowerCase());
    if (i === -1) {
      appended.push("", `## ${name}`, value);
      continue;
    }
    const next = headings[i + 1];
    edits.push({
      start: headings[i].line + 1,
      end: next ? next.line : lines.length,
      lines: next ? [value, ""] : [value],
    });
  }

  for (const edit of edits.sort((a, b) => b.start - a.start))
    lines.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return [...lines, ...appended].join("\n") + "\n";
}

async function syncNote(key: string) {
  const item = getZoteroRawItem(key);
  if (!item) return;
  const citeKey = citeKeyOf(item);
  if (!citeKey) {
    DEBUG(`${key} has no citation key, skipping.`);
    return;
  }
  const owner = Object.keys(state).find((k) => k !== key && state[k].citeKey === citeKey);
  if (owner) {
    DEBUG(`${owner} and ${key} both have citation key ${citeKey}, skipping ${key}.`);
    return;
  }

  const path = notePath(citeKey);
  const prev = state[key];
  if (prev && prev.citeKey !== citeKey) {
    const oldPath = notePath(prev.citeKey);
    if (!(await obsidian.noteExists(oldPath))) {
      // Nothing to rename; a new note is created below.
    } else if (await obsidian.noteExists(path)) {
      DEBUG(`Can't rename ${oldPath} to ${path}, which already exists.`);
    } else {
      await obsidian.noteRename(oldPath, path);
    }
  }

  const note = noteContent(item);
  const hash = createHash("sha1").update(JSON.stringify(note)).digest("hex");
  const existing = await obsidian.noteRead(path);
  if (existing === null) {
    await obsidian.noteWrite(path, noteTemplate(note));
  } else if (prev?.hash !== hash) {
    // Only touch the note when Zotero's data changed, so edits made in Obsidian aren't reverted on every check.
    const updated = updateNote(existing, note);
    if (updated !== existing) await obsidian.noteWrite(path, updated);
  }
  state[key] = { citeKey, hash };
}

async function removeNote(key: string) {
  const prev = state[key];
  if (!prev) return;
  delete state[key];
  if (Object.values(state).some((s) => s.citeKey === prev.citeKey)) return; // Now belongs to another item

  const path = notePath(prev.citeKey);
  if (!(await obsidian.noteExists(path))) return;
  const backlinks = await obsidian.noteBacklinks(path);
  if (backlinks.length > 0) {
    DEBUG(`Keeping ${path}, which is linked from ${backlinks.join(", ")}.`);
    return;
  }
  await obsidian.noteDelete(path);
}

/** Creates or updates notes for every item, and removes notes for items deleted since the last check. */
async function reconcile() {
  const items = getZoteroRawItems();
  DEBUG(`Checking notes for ${items.length} items.`);
  for (const item of items) await safely(() => syncNote(item.key));

  const current = new Set(items.map((i) => i.key));
  const removed = Object.keys(state).filter((k) => !current.has(k));
  // An empty library is more likely a misconfiguration than every item having been deleted.
  if (items.length === 0 && removed.length > 0) {
    DEBUG(`Zotero library is empty, not removing ${removed.length} notes.`);
  } else {
    for (const key of removed) await safely(() => removeNote(key));
  }
  DEBUG("Notes checked.");
}

export function zoteroNotes() {
  if (!zotero) return;

  onZoteroChange(({ changed, removed }) =>
    enqueue(async () => {
      for (const key of changed) await safely(() => syncNote(key));
      for (const key of removed) await safely(() => removeNote(key));
    }),
  );

  // Runs in the background once the library is loaded; changes that arrive meanwhile are queued behind it.
  enqueue(async () => {
    await loadState();
    await zoteroReady;
    await reconcile();
  });
}
