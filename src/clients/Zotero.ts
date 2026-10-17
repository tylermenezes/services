import { randomBytes } from "crypto";
import debug from "debug";
import { sleep } from "@/utils/sleep";

const DEBUG = debug("services:clients:zotero");

const PAGE_SIZE = 100;
const MAX_RETRIES = 4;

// Minimal client for the Zotero Web API v3: https://www.zotero.org/support/dev/web_api/v3/start
export class Zotero {
  private prefix: string;
  private backoffUntil = 0;
  private templates = new Map<string, Record<string, unknown>>();
  private creatorTypeCache = new Map<string, string[]>();

  constructor(
    private apiKey: string,
    userId: string,
    private baseUrl = "https://api.zotero.org",
  ) {
    this.prefix = `/users/${userId}`;
  }

  /** Requests a path in the user's library, or anywhere in the API if `scoped` is false. */
  private async request(
    path: string,
    params: Record<string, string | number> = {},
    init: RequestInit = {},
    scoped = true,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${scoped ? this.prefix : ""}${path}`);
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, v.toString());

    for (let attempt = 0; ; attempt++) {
      if (this.backoffUntil > Date.now()) await sleep(this.backoffUntil - Date.now());
      const retryDelay = 2000 * 2 ** attempt;
      let resp: Response;
      try {
        resp = await fetch(url, {
          ...init,
          headers: {
            "Zotero-API-Key": this.apiKey,
            "Zotero-API-Version": "3",
            ...init.headers,
          },
        });
      } catch (ex) {
        if (attempt >= MAX_RETRIES) throw ex;
        DEBUG(`Zotero ${url.pathname} failed (${ex}), retrying in ${retryDelay / 1000}s.`);
        await sleep(retryDelay);
        continue;
      }

      // Zotero asks clients to pause before their next request when rate-limited or under load.
      const wait = resp.headers.get("Retry-After") || resp.headers.get("Backoff");
      if (wait) this.backoffUntil = Date.now() + Number.parseInt(wait) * 1000;
      // Rate limits, and server errors, which are usually transient (e.g. formatting citations).
      if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
        DEBUG(`Zotero ${url.pathname} returned ${resp.status}, retrying in ${wait || retryDelay / 1000}s.`);
        if (!wait) await sleep(retryDelay);
        continue;
      }
      if (resp.status >= 400 && resp.status !== 404)
        throw new Error(`Zotero ${url.pathname} returned ${resp.status}: ${await resp.text()}`);
      return resp;
    }
  }

  private async fetchAll<T>(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<{ results: T[]; version: number }> {
    const results: T[] = [];
    let version = 0;
    let total = Infinity;
    while (results.length < total) {
      const resp = await this.request(path, { ...params, start: results.length, limit: PAGE_SIZE });
      const page = (await resp.json()) as T[];
      // Keep the version from the first page; if the library changes mid-pagination, the next sync catches it.
      version ||= Number.parseInt(resp.headers.get("Last-Modified-Version") || "0");
      total = Number.parseInt(resp.headers.get("Total-Results") || "0");
      results.push(...page);
      if (page.length === 0) break;
    }
    return { results, version };
  }

  /**
   * Items modified since the given library version (or all items), with formatted APA citations. Includes trashed
   * items so they can be evicted.
   */
  items(since?: number) {
    return this.fetchAll<ZoteroItem>("/items", {
      format: "json",
      include: "data,bib",
      style: "apa",
      includeTrashed: 1,
      ...(since ? { since } : {}),
    });
  }

  collections() {
    return this.fetchAll<ZoteroCollection>("/collections", { format: "json" });
  }

  /** Keys of items and collections permanently deleted since the given library version. */
  async deleted(since: number): Promise<{ items: string[]; collections: string[] }> {
    const resp = await this.request("/deleted", { since });
    return resp.json();
  }

  /** A short-lived signed URL for viewing a stored attachment file, or null if no file is stored. */
  async fileViewUrl(attachmentKey: string): Promise<string | null> {
    const resp = await this.request(`/items/${attachmentKey}/file/view/url`);
    if (!resp.ok) return null;
    return (await resp.text()).trim() || null;
  }

  /** An empty item of the given type, with every field it accepts. Throws for unknown item types. */
  async itemTemplate(itemType: string): Promise<Record<string, unknown>> {
    if (!this.templates.has(itemType)) {
      const resp = await this.request("/items/new", { itemType }, {}, false);
      if (!resp.ok) throw new Error(`Unknown Zotero item type: ${itemType}`);
      this.templates.set(itemType, await resp.json());
    }
    return structuredClone(this.templates.get(itemType)!);
  }

  /** Creator types (author, editor, ...) the given item type accepts. */
  async creatorTypes(itemType: string): Promise<string[]> {
    if (!this.creatorTypeCache.has(itemType)) {
      const resp = await this.request("/itemTypeCreatorTypes", { itemType }, {}, false);
      if (!resp.ok) throw new Error(`Unknown Zotero item type: ${itemType}`);
      const types = (await resp.json()) as { creatorType: string }[];
      this.creatorTypeCache.set(itemType, types.map((t) => t.creatorType));
    }
    return this.creatorTypeCache.get(itemType)!;
  }

  /** Creates an item, returning it as stored. Requires an API key with write access. */
  async createItem(data: Partial<ZoteroItemData>): Promise<ZoteroItem> {
    const resp = await this.request("/items", {}, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Makes retries safe: Zotero rejects a second request with the same token instead of creating a duplicate.
        "Zotero-Write-Token": randomBytes(16).toString("hex"),
      },
      body: JSON.stringify([data]),
    });
    const result = (await resp.json()) as {
      successful: Record<string, ZoteroItem>;
      failed: Record<string, { code: number; message: string }>;
    };
    if (result.failed["0"]) throw new Error(`Zotero rejected the item: ${result.failed["0"].message}`);
    return result.successful["0"];
  }

  /** The stored attachment file itself, or null if no file is stored. */
  async file(attachmentKey: string): Promise<Response | null> {
    const resp = await this.request(`/items/${attachmentKey}/file`);
    return resp.ok ? resp : null;
  }
}

export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  abstractNote?: string;
  date?: string;
  url?: string;
  DOI?: string;
  tags: { tag: string; type?: number }[];
  collections?: string[];
  relations: Record<string, string | string[]>;
  dateAdded: string;
  dateModified: string;
  deleted?: boolean | number;
  // Child items (attachments and notes)
  parentItem?: string;
  note?: string;
  linkMode?: "imported_file" | "imported_url" | "linked_file" | "linked_url" | "embedded_image";
  contentType?: string;
  filename?: string;
  md5?: string | null;
  mtime?: number | null;
  // Every other item-type-specific field (publicationTitle, volume, ISBN, ...)
  [field: string]: unknown;
}

export interface ZoteroItem {
  key: string;
  version: number;
  meta: {
    creatorSummary?: string;
    parsedDate?: string;
    numChildren?: number;
  };
  data: ZoteroItemData;
  /** HTML citation, if requested */
  bib?: string;
}

export interface ZoteroCollection {
  key: string;
  version: number;
  data: {
    key: string;
    name: string;
    parentCollection: string | false;
  };
}
