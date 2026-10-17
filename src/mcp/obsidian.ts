import { posix } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { obsidian } from "@/clients";
import { nonNullable } from "@/utils";
import { json } from "./util";

const SNIPPET_RADIUS = 80;
const MAX_SNIPPETS = 3;

/** Normalizes a vault-relative note path, adding .md if needed, and refuses anything outside the vault or hidden. */
function notePath(input: string): string {
  let path = posix.normalize(input.trim().replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!path.toLowerCase().endsWith(".md")) path += ".md";
  if (path.split("/").some((s) => s === ".." || s.startsWith(".")))
    throw new Error(`Invalid note path: ${input}`);
  return path;
}

function folderPrefix(folder: string | undefined): string {
  if (!folder?.trim()) return "";
  const path = posix.normalize(folder.trim().replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");
  if (path === ".") return "";
  if (path.split("/").some((s) => s === ".." || s.startsWith(".")))
    throw new Error(`Invalid folder: ${folder}`);
  return `${path}/`;
}

/** Visible markdown notes in the vault, optionally under a folder. */
async function listNotes(folder?: string): Promise<string[]> {
  const prefix = folderPrefix(folder);
  return (await obsidian.noteList())
    .filter(
      (p) =>
        p.endsWith(".md") &&
        p.startsWith(prefix) &&
        !p.split("/").some((s) => s.startsWith(".")),
    )
    .sort();
}

function snippets(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  const results: string[] = [];
  const covered: [number, number][] = [];
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i === -1) continue;
    if (covered.some(([s, e]) => i >= s && i + term.length <= e)) continue; // Already in an earlier snippet
    const start = Math.max(0, i - SNIPPET_RADIUS);
    const end = Math.min(text.length, i + term.length + SNIPPET_RADIUS);
    covered.push([start, end]);
    results.push(
      `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`,
    );
    if (results.length >= MAX_SNIPPETS) break;
  }
  return results;
}

function countOccurrences(haystack: string, needle: string) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

export function registerObsidianTools(server: McpServer) {
  server.registerTool(
    "obsidian_list_notes",
    {
      title: "List Obsidian notes",
      description: "Lists the paths of markdown notes in the Obsidian vault, optionally limited to a folder.",
      inputSchema: {
        folder: z.string().optional().describe("Vault-relative folder to list, e.g. 'Projects/2026'. Defaults to the whole vault."),
        limit: z.number().int().min(1).max(5000).default(500),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, limit, offset }) => {
      const notes = await listNotes(folder);
      return json({ total: notes.length, offset, notes: notes.slice(offset, offset + limit) });
    },
  );

  server.registerTool(
    "obsidian_search_notes",
    {
      title: "Search Obsidian notes",
      description:
        "Case-insensitive full-text search of note paths and contents. Every word in the query must appear somewhere " +
        "in the note. Results are ranked by relevance and include matching snippets.",
      inputSchema: {
        query: z.string().min(1),
        folder: z.string().optional().describe("Only search notes under this vault-relative folder."),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, folder, limit }) => {
      const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
      const notes = await obsidian.noteReadMulti(await listNotes(folder));
      const results = notes
        .map((note) => {
          const path = note.path.toLowerCase();
          const body = note.data.toLowerCase();
          if (!terms.every((t) => path.includes(t) || body.includes(t))) return null;
          const score = terms.reduce(
            (sum, t) => sum + (path.includes(t) ? 10 : 0) + Math.min(countOccurrences(body, t), 10),
            0,
          );
          return { path: note.path, score, updatedAt: note.updatedAt, snippets: snippets(note.data, terms) };
        })
        .filter(nonNullable)
        .sort((a, b) => b.score - a.score || +b.updatedAt - +a.updatedAt);
      return json({
        total: results.length,
        results: results.slice(0, limit).map(({ score, ...r }) => r),
      });
    },
  );

  server.registerTool(
    "obsidian_read_note",
    {
      title: "Read Obsidian note",
      description: "Reads the full markdown contents of a note, including frontmatter.",
      inputSchema: {
        path: z.string().describe("Vault-relative path to the note, e.g. 'Projects/Foo.md'. The .md is optional."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const p = notePath(path);
      const [note] = await obsidian.noteReadMulti([p]);
      if (!note) throw new Error(`Note not found: ${p}`);
      return {
        content: [
          { type: "text", text: `Path: ${note.path}\nLast modified: ${note.updatedAt.toISOString()}\n\n${note.data}` },
        ],
      };
    },
  );

  server.registerTool(
    "obsidian_create_note",
    {
      title: "Create Obsidian note",
      description: "Creates a new note, along with any missing folders. Fails if the note already exists.",
      inputSchema: {
        path: z.string().describe("Vault-relative path for the new note, e.g. 'Inbox/Idea.md'. The .md is optional."),
        content: z.string().describe("Markdown contents of the note, including any frontmatter."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, content }) => {
      const p = notePath(path);
      if (await obsidian.noteExists(p)) throw new Error(`Note already exists: ${p}`);
      await obsidian.noteWrite(p, content);
      return json({ created: p });
    },
  );

  server.registerTool(
    "obsidian_edit_note",
    {
      title: "Edit Obsidian note",
      description:
        "Edits an existing note in one of three ways: replace an exact passage (old_text and new_text), append text " +
        "to the end (append), or overwrite the whole note (content). Provide exactly one of these.",
      inputSchema: {
        path: z.string().describe("Vault-relative path to the note. The .md is optional."),
        old_text: z.string().optional().describe("Exact text to find. Must appear exactly once unless replace_all is set."),
        new_text: z.string().optional().describe("Text to replace old_text with."),
        replace_all: z.boolean().default(false).describe("Replace every occurrence of old_text."),
        append: z.string().optional().describe("Text to add to the end of the note."),
        content: z.string().optional().describe("New contents for the whole note."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ path, old_text, new_text, replace_all, append, content }) => {
      const p = notePath(path);
      const modes = [old_text !== undefined, append !== undefined, content !== undefined].filter(Boolean).length;
      if (modes !== 1) throw new Error("Provide exactly one of old_text/new_text, append, or content.");

      const existing = await obsidian.noteRead(p);
      if (existing === null) throw new Error(`Note not found: ${p}`);

      let updated: string;
      if (content !== undefined) {
        updated = content;
      } else if (append !== undefined) {
        updated = existing + (existing === "" || existing.endsWith("\n") ? "" : "\n") + append;
      } else {
        if (new_text === undefined) throw new Error("new_text is required with old_text.");
        if (old_text === "") throw new Error("old_text can't be empty.");
        const count = countOccurrences(existing, old_text!);
        if (count === 0) throw new Error("old_text was not found in the note.");
        if (count > 1 && !replace_all)
          throw new Error(`old_text appears ${count} times; add more context to make it unique, or set replace_all.`);
        updated = replace_all ? existing.split(old_text!).join(new_text) : existing.replace(old_text!, () => new_text);
      }

      await obsidian.noteWrite(p, updated);
      return json({ updated: p });
    },
  );

  server.registerTool(
    "obsidian_rename_note",
    {
      title: "Rename Obsidian note",
      description:
        "Renames or moves a note, and updates every link to it across the vault (wikilinks, embeds, and markdown " +
        "links), as Obsidian does. Fails if a note already exists at the new path.",
      inputSchema: {
        from: z.string().describe("Current vault-relative path of the note. The .md is optional."),
        to: z
          .string()
          .describe("New vault-relative path, including the folder: 'Projects/New Name.md' keeps a note in Projects."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ from, to }) => {
      const [fromPath, toPath] = [notePath(from), notePath(to)];
      if (fromPath === toPath) throw new Error("The new path is the same as the old one.");
      const result = await obsidian.noteRename(fromPath, toPath);
      return json({ renamed: { from: fromPath, to: toPath }, ...result });
    },
  );
}
