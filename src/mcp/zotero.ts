import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import config from "@/config";
import { zotero } from "@/clients";
import {
  findZoteroKeyByCiteKey,
  FormattedZoteroItem,
  getZoteroFile,
  getZoteroItem,
  getZoteroItems,
  getZoteroRawItem,
  zoteroCitationMarkdown,
  zoteroReady,
} from "@/datasources";
import { nonNullable } from "@/utils";
import { json } from "./util";

const READY_TIMEOUT = 30_000;
// Base64 inflates this by a third, so keep embedded PDFs comfortably under typical client limits.
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Waits for the library to load, which takes about a minute after startup. */
export async function ready() {
  if (!zotero) throw new Error("Zotero is not configured (ZOTERO_API_KEY and ZOTERO_USER_ID).");
  let timeout: NodeJS.Timeout;
  await Promise.race([
    zoteroReady,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("The Zotero library is still loading; try again in a minute.")),
        READY_TIMEOUT,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

/** Resolves a citation key or Zotero item key to an item key. */
function resolve(id: string): string {
  const key = getZoteroItem(id) ? id : findZoteroKeyByCiteKey(id);
  if (!key) throw new Error(`No Zotero item with citation key or item key "${id}".`);
  return key;
}

/** The first of the given item-type-specific fields which is set. */
function field(item: FormattedZoteroItem, ...names: string[]): string | undefined {
  const data = item as unknown as Record<string, unknown>;
  const name = names.find((n) => data[n]);
  return name ? String(data[name]).trim() : undefined;
}

function titleOf(item: FormattedZoteroItem) {
  // Some item types name their title field differently.
  return field(item, "title", "caseName", "subject", "nameOfAct") || "";
}

const PUBLICATION_FIELDS = ["publicationTitle", "bookTitle", "proceedingsTitle", "websiteTitle", "blogTitle"];

function summarize(item: FormattedZoteroItem) {
  return {
    key: item.key,
    citeKey: item.citeKey,
    itemType: item.itemType,
    title: titleOf(item),
    creators: item.creatorSummary,
    date: item.parsedDate || item.date,
    publication: field(item, ...PUBLICATION_FIELDS),
    hasPdf: !!item.pdf,
  };
}

function normalizeName(name: string) {
  return name.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The roles (author, editor, presenter, ...) in which a person is credited on an item. Matches the full name, or the
 * last name and first given name, so "Tyler J. Menezes" also counts.
 */
function creditsFor(item: FormattedZoteroItem, name: string): string[] {
  const full = normalizeName(name);
  const [first, ...rest] = full.split(" ");
  const last = rest.join(" ");
  return (item.creators || [])
    .filter(
      (c) =>
        normalizeName(c.name || `${c.firstName || ""} ${c.lastName || ""}`) === full ||
        (normalizeName(c.lastName || "") === last && normalizeName(c.firstName || "").split(" ")[0] === first),
    )
    .map((c) => c.creatorType);
}

/** Matches a collection by key or (case-insensitive) name, and a tag by (case-insensitive) name. */
function filterItems(items: FormattedZoteroItem[], collection?: string, tag?: string) {
  return items.filter(
    (item) =>
      (!collection ||
        item.collections.some((c) => c.key === collection || c.name.toLowerCase() === collection.toLowerCase())) &&
      (!tag || item.tags.some((t) => t.toLowerCase() === tag.toLowerCase())),
  );
}

function searchFields(item: FormattedZoteroItem) {
  const creators = (item.creators || []).map((c) => c.name || `${c.firstName || ""} ${c.lastName || ""}`);
  return {
    primary: [titleOf(item), item.citeKey, ...creators].join(" ").toLowerCase(),
    secondary: [
      item.abstractNote,
      item.tags.join(" "),
      item.DOI,
      item.date,
      field(item, "extra"),
      ...PUBLICATION_FIELDS.map((f) => field(item, f)),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

/** Downloads an item's PDF, wherever it's stored. */
async function fetchPdf(key: string): Promise<Uint8Array> {
  const file = await getZoteroFile(key);
  if (!file) throw new Error("This item has no PDF stored in Zotero or linked by URL.");
  const resp = "redirect" in file ? await fetch(file.redirect) : file.response;
  if (!resp.ok) throw new Error(`Could not download the PDF (HTTP ${resp.status}).`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  // Linked URLs can point at a landing page rather than the PDF itself.
  if (new TextDecoder().decode(bytes.slice(0, 1024)).indexOf("%PDF-") === -1)
    throw new Error("The attachment didn't return a PDF; it may link to a web page instead.");
  return bytes;
}

export function registerZoteroTools(server: McpServer) {
  server.registerTool(
    "zotero_list_items",
    {
      title: "List Zotero items",
      description:
        "Lists items in the Zotero library, most recently added first, optionally filtered by collection or tag. " +
        "Returns summaries; use zotero_read_item for full details.",
      inputSchema: {
        collection: z.string().optional().describe("Collection name or key."),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ collection, tag, limit, offset }) => {
      await ready();
      const items = filterItems(getZoteroItems(), collection, tag);
      return json({ total: items.length, offset, items: items.slice(offset, offset + limit).map(summarize) });
    },
  );

  server.registerTool(
    "zotero_search_items",
    {
      title: "Search Zotero items",
      description:
        "Case-insensitive search of the Zotero library by title, authors, citation key, abstract, tags, DOI, " +
        "publication, and date. Every word in the query must match. Returns summaries ranked by relevance.",
      inputSchema: {
        query: z.string().min(1),
        collection: z.string().optional().describe("Collection name or key."),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, collection, tag, limit }) => {
      await ready();
      const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
      const results = filterItems(getZoteroItems(), collection, tag)
        .map((item) => {
          const { primary, secondary } = searchFields(item);
          if (!terms.every((t) => primary.includes(t) || secondary.includes(t))) return null;
          const score = terms.reduce((sum, t) => sum + (primary.includes(t) ? 3 : 1), 0);
          return { item, score };
        })
        .filter(nonNullable)
        .sort((a, b) => b.score - a.score);
      return json({ total: results.length, items: results.slice(0, limit).map((r) => summarize(r.item)) });
    },
  );

  server.registerTool(
    "zotero_my_items",
    {
      title: "List my Zotero items",
      description:
        `Lists every Zotero item crediting ${config.app.myName} as a creator (author, editor, presenter, etc.), ` +
        "newest first, with the role(s) credited on each.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      await ready();
      const items = getZoteroItems()
        .map((item) => ({ ...summarize(item), roles: [...new Set(creditsFor(item, config.app.myName))] }))
        .filter((item) => item.roles.length > 0)
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      return json({ name: config.app.myName, total: items.length, items });
    },
  );

  server.registerTool(
    "zotero_read_item",
    {
      title: "Read Zotero item",
      description:
        "Gets every field of a Zotero item, including its abstract, collections, tags, attachments, and an APA citation.",
      inputSchema: {
        id: z.string().describe("Citation key, or Zotero item key."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      await ready();
      const key = resolve(id);
      const { relations, version, ...item } = getZoteroItem(key)!;
      return json({ ...item, citation: zoteroCitationMarkdown(getZoteroRawItem(key)?.bib) });
    },
  );

  server.registerTool(
    "zotero_get_pdf",
    {
      title: "Get Zotero PDF",
      description:
        "Fetches the PDF attached to a Zotero item. By default returns the extracted text, with page markers; " +
        "set format to 'pdf' to get the PDF file itself, or 'url' to get a short-lived link to download it.",
      inputSchema: {
        cite_key: z.string().describe("Citation key, or Zotero item key."),
        format: z.enum(["text", "pdf", "url"]).default("text"),
        start_page: z.number().int().min(1).optional().describe("First page of text to return (text format only)."),
        end_page: z.number().int().min(1).optional().describe("Last page of text to return (text format only)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ cite_key, format, start_page, end_page }) => {
      await ready();
      const key = resolve(cite_key);
      const item = getZoteroItem(key)!;
      const label = `${item.citeKey || key}: ${titleOf(item)}`;

      if (format === "url") {
        const file = await getZoteroFile(key);
        if (!file) throw new Error("This item has no PDF stored in Zotero or linked by URL.");
        if (!("redirect" in file)) {
          await file.response.body?.cancel();
          throw new Error("Zotero didn't provide a link for this PDF; use the text or pdf format instead.");
        }
        return {
          content: [
            { type: "text", text: `${label}\n${file.redirect}` },
            { type: "resource_link", uri: file.redirect, name: label, mimeType: "application/pdf" },
          ],
        };
      }

      const bytes = await fetchPdf(key);

      if (format === "pdf") {
        if (bytes.length > MAX_PDF_BYTES)
          throw new Error(`The PDF is ${Math.round(bytes.length / 1024 / 1024)} MB; use the text format instead.`);
        return {
          content: [
            { type: "text", text: label },
            {
              type: "resource",
              resource: {
                uri: `zotero://select/library/items/${key}`,
                mimeType: "application/pdf",
                blob: Buffer.from(bytes).toString("base64"),
              },
            },
          ],
        };
      }

      const { totalPages, text } = await extractText(await getDocumentProxy(bytes), { mergePages: false });
      const first = start_page || 1;
      const last = Math.min(end_page || totalPages, totalPages);
      if (first > last) throw new Error(`Page range ${first}-${last} is empty; the PDF has ${totalPages} pages.`);
      const pages = text
        .slice(first - 1, last)
        .map((page, i) => `--- Page ${first + i} ---\n${page.trim()}`)
        .join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `${label}\nPages ${first}-${last} of ${totalPages}\n\n${pages.trim() || "(No extractable text; the PDF may be scanned images.)"}`,
          },
        ],
      };
    },
  );
}
