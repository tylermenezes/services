import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { zotero, ZoteroCreator, ZoteroItemData } from "@/clients";
import {
  getZoteroCollections,
  getZoteroItem,
  getZoteroItems,
  getZoteroRawItem,
  zoteroCitationMarkdown,
  zoteroUpdate,
} from "@/datasources";
import { json } from "./util";
import { ready } from "./zotero";

// Fields set by the tools themselves, or by Zotero.
const RESERVED_FIELDS = ["itemType", "creators", "tags", "collections", "relations", "citationKey"];

// https://docs.citationstyles.org/en/stable/specification.html#appendix-iii-types, plus Crossref's own names.
const CSL_TYPES: Record<string, string> = {
  "article-journal": "journalArticle",
  "journal-article": "journalArticle",
  "paper-conference": "conferencePaper",
  "proceedings-article": "conferencePaper",
  book: "book",
  monograph: "book",
  "edited-book": "book",
  chapter: "bookSection",
  "book-chapter": "bookSection",
  report: "report",
  thesis: "thesis",
  dissertation: "thesis",
  dataset: "dataset",
  "posted-content": "preprint",
  article: "preprint", // DataCite's type for arXiv and other preprints
  webpage: "webpage",
};

// Which field a CSL container title or publisher goes in depends on the item type; the first one the type has wins.
const CONTAINER_FIELDS = ["publicationTitle", "proceedingsTitle", "bookTitle", "websiteTitle", "repository"];
const PUBLISHER_FIELDS = ["publisher", "institution", "university", "repository"];

// Words Better BibTeX's shorttitle skips.
const FUNCTION_WORDS = new Set(
  ("a an the and or nor but so yet for of in on at to by from with without within into onto upon over under " +
    "about above across after against along among around as before behind below beneath beside between beyond " +
    "during except inside like near off out past per since than through toward towards until up via versus").split(" "),
);

const creatorSchema = z.object({
  creator_type: z.string().default("author").describe("author, editor, presenter, etc."),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  name: z.string().optional().describe("Full name, for organizations or single-field names, instead of first/last."),
});

const commonInputs = {
  cite_key: z
    .string()
    .optional()
    .describe("Citation key. Defaults to a Better BibTeX-style key, e.g. 'smithDeepLearningSystems2024'."),
  collections: z.array(z.string()).optional().describe("Names or keys of collections to add the item to."),
  tags: z.array(z.string()).optional(),
  allow_duplicate: z
    .boolean()
    .default(false)
    .describe("Create the item even if one with the same DOI or ISBN already exists."),
};

interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}

interface CslItem {
  type?: string;
  title?: string | string[];
  "container-title"?: string | string[];
  "container-title-short"?: string | string[];
  "short-container-title"?: string | string[];
  publisher?: string;
  "publisher-place"?: string;
  event?: string | { name?: string };
  "event-title"?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string;
  ISBN?: string | string[];
  ISSN?: string | string[];
  DOI?: string;
  URL?: string;
  abstract?: string;
  language?: string;
  issued?: { "date-parts"?: (number | string)[][]; literal?: string };
  author?: CslName[];
  editor?: CslName[];
  translator?: CslName[];
}

function normalizeDoi(doi: string) {
  return doi
    .trim()
    .replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "")
    .replace(/[.,;]+$/, "") // Trailing punctuation from pasted text
    .toLowerCase();
}

function checkDigit13(digits: string) {
  const sum = [...digits].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}

/** The ISBN-13 form of an ISBN-10 or ISBN-13, ignoring hyphens and spaces, or null if it isn't a valid ISBN. */
function isbn13(input: string): string | null {
  const isbn = input
    .trim()
    .replace(/^isbn(-1[03])?:?\s*/i, "")
    .replace(/[.,;]+$/, "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((acc, d, i) => acc + (d === "X" ? 10 : Number(d)) * (10 - i), 0);
    if (sum % 11) return null;
    const core = `978${isbn.slice(0, 9)}`;
    return core + checkDigit13(core);
  }
  if (/^\d{13}$/.test(isbn)) return checkDigit13(isbn.slice(0, 12)) === isbn[12] ? isbn : null;
  return null;
}

type Identifier = { type: "DOI" | "ISBN"; value: string };

function parseIdentifier(input: string): Identifier {
  const doi = normalizeDoi(input);
  if (/^10\.\S+\/\S+$/.test(doi)) return { type: "DOI", value: doi };
  const isbn = isbn13(input);
  if (isbn) return { type: "ISBN", value: isbn };
  throw new Error(`Not a valid DOI or ISBN: ${input}`);
}

function first(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.toString().trim() || undefined;
}

function cslDate(issued: CslItem["issued"]): string | undefined {
  const parts = issued?.["date-parts"]?.[0]?.filter((p) => p !== null && p !== undefined);
  if (parts?.length) return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, "0"))).join("-");
  return issued?.literal;
}

function cslCreators(csl: CslItem): ZoteroCreator[] {
  const roles = [["author", csl.author], ["editor", csl.editor], ["translator", csl.translator]] as const;
  return roles.flatMap(([creatorType, names]) =>
    (names || []).map((n) =>
      n.family ? { creatorType, firstName: n.given || "", lastName: n.family } : { creatorType, name: n.literal || n.given || "" },
    ),
  );
}

/** Looks up a DOI's metadata with content negotiation, which works for Crossref, DataCite, and other registries. */
async function lookupDoi(doi: string): Promise<CslItem> {
  const resp = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
    headers: { Accept: "application/vnd.citationstyles.csl+json" },
  });
  if (resp.status === 404) throw new Error(`DOI not found: ${doi}`);
  if (!resp.ok) throw new Error(`Could not look up DOI ${doi} (HTTP ${resp.status}).`);
  return resp.json();
}

interface OpenLibraryBook {
  title?: string;
  subtitle?: string;
  authors?: { name: string }[];
  publishers?: { name: string }[];
  publish_places?: { name: string }[];
  publish_date?: string;
  number_of_pages?: number;
}

/** Splits a full name, as "First Middle Last" or "Last, First", into Zotero's fields. */
function authorFromName(name: string): ZoteroCreator {
  const full = name.trim();
  const comma = full.indexOf(",");
  const parts = full.split(/\s+/);
  const lastName = comma === -1 ? parts.pop()! : full.slice(0, comma).trim();
  const firstName = comma === -1 ? parts.join(" ") : full.slice(comma + 1).trim();
  return firstName ? { creatorType: "author", firstName, lastName } : { creatorType: "author", name: full };
}

/** Looks up a book in Open Library, one of the catalogs Zotero itself uses for ISBNs. */
async function lookupIsbn(isbn: string): Promise<{ itemType: string; fields: Record<string, string>; creators: ZoteroCreator[] }> {
  const resp = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  if (!resp.ok) throw new Error(`Could not look up ISBN ${isbn} (HTTP ${resp.status}).`);
  const book = ((await resp.json()) as Record<string, OpenLibraryBook>)[`ISBN:${isbn}`];
  if (!book?.title) throw new Error(`No book with ISBN ${isbn} in Open Library; use zotero_create_item instead.`);
  const fields: Record<string, string | undefined> = {
    title: book.subtitle ? `${book.title}: ${book.subtitle}` : book.title,
    publisher: book.publishers?.[0]?.name,
    place: book.publish_places?.[0]?.name,
    date: book.publish_date,
    numPages: book.number_of_pages?.toString(),
    ISBN: isbn,
  };
  return {
    itemType: "book",
    fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) as Record<string, string>,
    creators: (book.authors || []).map((a) => authorFromName(a.name)),
  };
}

/** Converts DOI metadata into the item type and fields Zotero would use. */
function fromCsl(csl: CslItem, doi: string): { itemType: string; fields: Record<string, string>; creators: ZoteroCreator[] } {
  const container = first(csl["container-title"]);
  const itemType = CSL_TYPES[csl.type || ""] || (container ? "journalArticle" : "document");
  const event = typeof csl.event === "string" ? csl.event : csl.event?.name;
  const fields: Record<string, string | undefined> = {
    title: first(csl.title),
    abstractNote: csl.abstract
      ?.replace(/<jats:title>.*?<\/jats:title>/gs, "") // Crossref abstracts are JATS XML, often headed "Abstract"
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    date: cslDate(csl.issued),
    volume: csl.volume?.toString(),
    issue: csl.issue?.toString(),
    pages: csl.page,
    place: csl["publisher-place"],
    conferenceName: csl["event-title"] || event,
    journalAbbreviation: first(csl["container-title-short"]) || first(csl["short-container-title"]),
    ISBN: first(csl.ISBN),
    ISSN: Array.isArray(csl.ISSN) ? csl.ISSN.join(", ") : csl.ISSN,
    language: csl.language,
    DOI: csl.DOI || doi,
    url: csl.URL,
    // Placeholders, resolved to whichever field the item type has.
    _container: container,
    _publisher: csl.publisher,
  };
  return {
    itemType,
    fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) as Record<string, string>,
    creators: cslCreators(csl),
  };
}

/** A key in Better BibTeX's default format: auth.lower + shorttitle(3,3) + year, made unique with a letter suffix. */
function generateCiteKey(fields: Record<string, string>, creators: ZoteroCreator[]): string {
  const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const author = creators.find((c) => c.creatorType === "author") || creators[0];
  const auth = ascii(author?.lastName || author?.name?.split(/\s+/).pop() || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const title = ascii(fields.title || "")
    .split(/\s+/) // Hyphenated words count as one, e.g. "LLM-Assistants" → "LLMAssistants"
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter((w) => w && !FUNCTION_WORDS.has(w.toLowerCase()))
    .slice(0, 3)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  const year = fields.date?.match(/\d{4}/)?.[0] || "";
  const base = `${auth}${title}${year}` || "item";

  const taken = new Set(getZoteroItems().map((i) => i.citeKey?.toLowerCase()).filter(Boolean));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 0; ; i++) {
    const suffix = i < 26 ? String.fromCharCode(97 + i) : String(i);
    if (!taken.has(`${base}${suffix}`.toLowerCase())) return `${base}${suffix}`;
  }
}

function resolveCollections(names: string[] = []): string[] {
  const all = getZoteroCollections();
  return names.map((name) => {
    const match =
      all.find((c) => c.key === name) || all.find((c) => c.data.name.toLowerCase() === name.toLowerCase());
    if (!match) throw new Error(`No Zotero collection named "${name}".`);
    return match.key;
  });
}

/** An item already in the library with the given DOI or ISBN. Zotero's ISBN field can hold several ISBNs. */
function findExisting({ type, value }: Identifier) {
  return (
    getZoteroItems().find((i) => {
      if (type === "DOI") return i.DOI && normalizeDoi(i.DOI) === value;
      const isbns = String((i as unknown as Record<string, unknown>).ISBN || "").split(/[\s,;]+/);
      return isbns.some((isbn) => isbn && isbn13(isbn) === value);
    }) || null
  );
}

/** Validates and creates an item, waits for it to sync into the cache, and describes the result. */
async function createItem(
  itemType: string,
  fields: Record<string, string>,
  creators: ZoteroCreator[],
  opts: { cite_key?: string; collections?: string[]; tags?: string[]; strict: boolean },
) {
  const template = await zotero!.itemTemplate(itemType);
  const validFields = Object.keys(template).filter((f) => !RESERVED_FIELDS.includes(f));
  const validCreatorTypes = await zotero!.creatorTypes(itemType);

  // Placeholders from DOI metadata go in the first matching field the item type has, if not already filled.
  const resolved: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields)) {
    const candidates = field === "_container" ? CONTAINER_FIELDS : field === "_publisher" ? PUBLISHER_FIELDS : null;
    const target = candidates ? candidates.find((f) => validFields.includes(f) && !resolved[f] && !fields[f]) : field;
    if (target) resolved[target] = value;
  }

  const invalid = Object.keys(resolved).filter((f) => !validFields.includes(f));
  if (invalid.length && opts.strict)
    throw new Error(`${itemType} items don't have the field(s) ${invalid.join(", ")}. Valid fields: ${validFields.join(", ")}.`);
  const badCreators = [...new Set(creators.map((c) => c.creatorType))].filter((t) => !validCreatorTypes.includes(t));
  if (badCreators.length && opts.strict)
    throw new Error(`${itemType} items don't have creator type(s) ${badCreators.join(", ")}. Valid: ${validCreatorTypes.join(", ")}.`);

  const data: Partial<ZoteroItemData> = {
    ...template,
    ...Object.fromEntries(Object.entries(resolved).filter(([f]) => validFields.includes(f))),
    itemType,
    creators: creators.filter((c) => validCreatorTypes.includes(c.creatorType)),
    tags: (opts.tags || []).map((tag) => ({ tag })),
    collections: resolveCollections(opts.collections),
    citationKey: opts.cite_key?.trim() || generateCiteKey(resolved, creators),
  };

  let created;
  try {
    created = await zotero!.createItem(data);
  } catch (ex) {
    if (String(ex).includes("returned 403"))
      throw new Error(
        "The Zotero API key doesn't have write access. Enable 'Allow write access' for it at https://www.zotero.org/settings/keys.",
      );
    throw ex;
  }

  await zoteroUpdate();
  const item = getZoteroItem(created.key);
  return json({
    created: true,
    key: created.key,
    citeKey: data.citationKey,
    title: data.title,
    citation: zoteroCitationMarkdown(getZoteroRawItem(created.key)?.bib) || undefined,
    collections: item?.collections,
    ...(invalid.length ? { droppedFields: invalid } : {}),
  });
}

function duplicateResult(existing: NonNullable<ReturnType<typeof findExisting>>, type: Identifier["type"]) {
  return json({
    created: false,
    reason: `An item with this ${type} is already in the library; set allow_duplicate to add another.`,
    key: existing.key,
    citeKey: existing.citeKey,
    title: existing.title,
  });
}

export function registerZoteroCreateTools(server: McpServer) {
  server.registerTool(
    "zotero_add_item_by_identifier",
    {
      title: "Add Zotero item by DOI or ISBN",
      description:
        "Adds an item to the Zotero library from its DOI or ISBN, like Zotero's Add Item by Identifier. DOIs fill in " +
        "the title, authors, publication, date, abstract, and other details from the DOI registry; ISBNs add a book " +
        "with its authors, publisher, and date from Open Library. Doesn't attach a PDF.",
      inputSchema: {
        identifier: z
          .string()
          .describe("DOI (e.g. '10.1145/3626252.3630800', or a doi.org URL) or ISBN-10/13 (hyphens are fine)."),
        ...commonInputs,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ identifier, cite_key, collections, tags, allow_duplicate }) => {
      await ready();
      const id = parseIdentifier(identifier);
      const existing = findExisting(id);
      if (existing && !allow_duplicate) return duplicateResult(existing, id.type);

      const { itemType, fields, creators } =
        id.type === "DOI" ? fromCsl(await lookupDoi(id.value), id.value) : await lookupIsbn(id.value);
      return createItem(itemType, fields, creators, { cite_key, collections, tags, strict: false });
    },
  );

  server.registerTool(
    "zotero_create_item",
    {
      title: "Create Zotero item",
      description:
        "Creates an item in the Zotero library from full details you provide. Use zotero_add_item_by_identifier instead " +
        "when the item has a DOI or ISBN. Fields use Zotero's names, which vary by item type: e.g. journalArticle has " +
        "publicationTitle, volume, issue, pages; conferencePaper has proceedingsTitle and conferenceName; book has " +
        "publisher and ISBN; webpage has websiteTitle. Invalid fields are rejected with a list of valid ones.",
      inputSchema: {
        item_type: z
          .string()
          .describe("Zotero item type, e.g. journalArticle, conferencePaper, book, bookSection, report, thesis, preprint, webpage."),
        fields: z
          .record(z.string(), z.string())
          .describe("Zotero fields, e.g. { title, date, publicationTitle, DOI, url, abstractNote }."),
        creators: z.array(creatorSchema).default([]),
        ...commonInputs,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ item_type, fields, creators, cite_key, collections, tags, allow_duplicate }) => {
      await ready();
      if (!fields.title?.trim()) throw new Error("fields.title is required.");
      const reserved = Object.keys(fields).filter((f) => RESERVED_FIELDS.includes(f) || f.startsWith("_"));
      if (reserved.length)
        throw new Error(`Use the tool's own parameters instead of fields.${reserved.join(", fields.")}.`);
      const ids: Identifier[] = [];
      if (fields.DOI) ids.push({ type: "DOI", value: normalizeDoi(fields.DOI) });
      const isbn = fields.ISBN && isbn13(fields.ISBN.split(/[\s,;]+/)[0]);
      if (isbn) ids.push({ type: "ISBN", value: isbn });
      for (const id of ids) {
        const existing = findExisting(id);
        if (existing && !allow_duplicate) return duplicateResult(existing, id.type);
      }

      const zoteroCreators: ZoteroCreator[] = creators.map((c) => {
        if (c.name?.trim()) return { creatorType: c.creator_type, name: c.name.trim() };
        if (!c.last_name?.trim()) throw new Error("Each creator needs a last_name or a name.");
        return { creatorType: c.creator_type, firstName: c.first_name?.trim() || "", lastName: c.last_name.trim() };
      });
      return createItem(item_type, fields, zoteroCreators, { cite_key, collections, tags, strict: true });
    },
  );
}
