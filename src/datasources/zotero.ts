import schedule from "node-schedule";
import debug from "debug";
import config from "@/config";
import { zotero, ZoteroCollection, ZoteroItem } from "@/clients";
import { ZoteroStream } from "@/clients/ZoteroStream";

const DEBUG = debug("services:datasources:zotero");

let libraryVersion = 0;
let streamVersion = 0; // Latest version announced by the stream
let updating: Promise<void> | null = null;
let updatePending = false;
let lastSyncFailed = false;
const items = new Map<string, ZoteroItem>();
let children = new Map<string, ZoteroItem[]>();
let collections = new Map<string, ZoteroCollection>();

export interface ZoteroChange {
  /** Keys of top-level items which were added or edited */
  changed: string[];
  /** Keys of items which were trashed or deleted */
  removed: string[];
}
const changeListeners: ((change: ZoteroChange) => void)[] = [];

export function onZoteroChange(listener: (change: ZoteroChange) => void) {
  changeListeners.push(listener);
}

let markReady: () => void;
/** Resolves once the whole library has been fetched. */
export const zoteroReady = new Promise<void>((resolve) => { markReady = resolve; });

/** Zotero's citation key field, or the one Better BibTeX pins in Extra. */
export function zoteroCiteKey(item: ZoteroItem): string | null {
  return (
    (item.data.citationKey as string | undefined)?.trim() ||
    (item.data.extra as string | undefined)?.match(/^\s*Citation Key:\s*(\S+)\s*$/im)?.[1] ||
    null
  );
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
export function zoteroCitationMarkdown(html: string | undefined) {
  return decodeEntities(
    (html || "")
      .replace(/<\/?(i|em)>/g, "*")
      .replace(/<\/?(b|strong)>/g, "**")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function isTopLevel(item: ZoteroItem) {
  return !item.data.parentItem && !["attachment", "note"].includes(item.data.itemType);
}

function childrenOf(key: string) {
  return children.get(key) || [];
}

function formatAttachment(item: ZoteroItem) {
  return {
    key: item.key,
    title: item.data.title,
    linkMode: item.data.linkMode,
    contentType: item.data.contentType,
    filename: item.data.filename,
    url: item.data.url,
  };
}

function formatItem(item: ZoteroItem) {
  // Notes are deliberately excluded.
  const attachments = childrenOf(item.key).filter((c) => c.data.itemType === "attachment");
  return {
    ...item.data,
    citeKey: zoteroCiteKey(item),
    creatorSummary: item.meta.creatorSummary,
    parsedDate: item.meta.parsedDate,
    tags: item.data.tags.map((t) => t.tag),
    collections: (item.data.collections || [])
      .map((k) => collections.get(k))
      .filter(Boolean)
      .map((c) => ({ key: c!.key, name: c!.data.name })),
    attachments: attachments.map(formatAttachment),
    pdf: findPdfAttachment(item.key)?.key || null,
  };
}

export type FormattedZoteroItem = ReturnType<typeof formatItem>;

export function getZoteroItems(): FormattedZoteroItem[] {
  return [...items.values()]
    .filter(isTopLevel)
    .map(formatItem)
    .sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1));
}

export function getZoteroCollections(): ZoteroCollection[] {
  return [...collections.values()];
}

/** Top-level items as returned by the API, including the APA citation. */
export function getZoteroRawItems(): ZoteroItem[] {
  return [...items.values()].filter(isTopLevel);
}

export function getZoteroRawItem(key: string): ZoteroItem | null {
  const item = items.get(key);
  return item && isTopLevel(item) ? item : null;
}

export function getZoteroItem(key: string): FormattedZoteroItem | null {
  const item = items.get(key);
  return item && isTopLevel(item) ? formatItem(item) : null;
}

/** The key of the top-level item with the given citation key, matching case-insensitively if there's no exact match. */
export function findZoteroKeyByCiteKey(citeKey: string): string | null {
  const topLevel = [...items.values()].filter(isTopLevel);
  const lower = citeKey.toLowerCase();
  return (
    topLevel.find((i) => zoteroCiteKey(i) === citeKey)?.key ||
    topLevel.find((i) => zoteroCiteKey(i)?.toLowerCase() === lower)?.key ||
    null
  );
}

/** Resolves an item or attachment key to the attachment holding its PDF, preferring files stored in Zotero. */
function findPdfAttachment(key: string): ZoteroItem | null {
  const item = items.get(key);
  if (!item) return null;
  if (item.data.itemType === "attachment") return item;

  const pdfs = childrenOf(key).filter(
    (c) => c.data.itemType === "attachment" && c.data.contentType === "application/pdf",
  );
  return (
    pdfs.find((c) => c.data.linkMode === "imported_file" || c.data.linkMode === "imported_url") ||
    pdfs.find((c) => c.data.linkMode === "linked_url") ||
    null
  );
}

export type ZoteroFile = { redirect: string } | { response: Response };

/**
 * Locates the stored file for an item or attachment key. Prefers a URL the client can be redirected to, and falls
 * back to the file contents. Keys not yet in the cache are tried directly as attachment keys.
 */
export async function getZoteroFile(key: string): Promise<ZoteroFile | null> {
  if (!zotero) return null;
  const attachment = findPdfAttachment(key);
  if (items.has(key) && !attachment) return null;
  if (attachment?.data.linkMode === "linked_url" && attachment.data.url)
    return { redirect: attachment.data.url };
  if (attachment?.data.linkMode === "linked_file") return null; // Only exists on the computer that added it

  const attachmentKey = attachment?.key || key;
  const redirect = await zotero.fileViewUrl(attachmentKey);
  if (redirect) return { redirect };
  const response = await zotero.file(attachmentKey);
  return response ? { response } : null;
}

/** Syncs the cache. If a sync is already running, another runs after it so no change is missed. */
export function zoteroUpdate(): Promise<void> {
  if (updating) {
    updatePending = true;
    return updating;
  }
  updating = (async () => {
    try {
      do {
        updatePending = false;
        await sync();
      } while (updatePending);
      lastSyncFailed = false;
    } catch (ex) {
      lastSyncFailed = true;
      throw ex;
    } finally {
      updating = null;
    }
  })();
  return updating;
}

async function sync() {
  if (!zotero) return;
  DEBUG(libraryVersion ? `Updating Zotero since version ${libraryVersion}.` : "Fetching Zotero library.");
  const since = libraryVersion || undefined;
  const [changed, deleted, newCollections] = await Promise.all([
    zotero.items(since),
    since ? zotero.deleted(since) : Promise.resolve({ items: [], collections: [] }),
    zotero.collections(),
  ]);

  const change: ZoteroChange = { changed: [], removed: [...deleted.items] };
  for (const item of changed.results) {
    if (item.data.deleted) { // Trashed
      items.delete(item.key);
      change.removed.push(item.key);
    } else {
      items.set(item.key, item);
      if (isTopLevel(item)) change.changed.push(item.key);
    }
  }
  for (const key of deleted.items) items.delete(key);
  children = new Map();
  for (const item of items.values()) {
    const parent = item.data.parentItem;
    if (parent) children.set(parent, [...(children.get(parent) || []), item]);
  }
  collections = new Map(newCollections.results.map((c) => [c.key, c]));
  if (changed.version) libraryVersion = changed.version;
  markReady();

  DEBUG(
    `${changed.results.length} items changed, ${deleted.items.length} deleted; ` +
      `${items.size} items cached at version ${libraryVersion}.`,
  );
  // The initial fetch isn't a change; listeners can wait for zoteroReady and read the whole library instead.
  if (since && (change.changed.length || change.removed.length))
    for (const listener of changeListeners) {
      try { listener(change); } catch (ex) { DEBUG(ex); }
    }
}

export async function scheduleZoteroUpdate() {
  if (!zotero) {
    DEBUG("ZOTERO_API_KEY or ZOTERO_USER_ID not set, skipping.");
    return;
  }

  // Per the streaming API docs, connect first and sync once subscribed so nothing is missed in between.
  const stream = new ZoteroStream(config.zotero.apiKey!, config.zotero.userId!, {
    onConnected: () => zoteroUpdate().catch(DEBUG),
    onUpdated: (version) => {
      streamVersion = Math.max(streamVersion, version);
      if (version > libraryVersion) zoteroUpdate().catch(DEBUG);
    },
    onDisconnected: () => zoteroUpdate().catch(DEBUG),
  });
  stream.connect();

  // Fetching the whole library with citations takes about a minute, so don't hold up startup for it.
  zoteroUpdate().catch(DEBUG);

  // Poll only while the stream is down, or to retry a failed sync.
  schedule.scheduleJob("*/5 * * * *", () => {
    if (!stream.connected || lastSyncFailed || libraryVersion < streamVersion) zoteroUpdate().catch(DEBUG);
  });
}
