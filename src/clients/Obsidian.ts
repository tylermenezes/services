import { promises as fs, createReadStream } from "fs";
import { createInterface as createRlInterface } from "node:readline/promises";
import { join, dirname, relative, posix } from "path";
import YAML from "yaml";
import debug from "debug";
import watch from "node-watch";
import config from "@/config";

const DEBUG = debug("services:clients:obsidian");
const VAULT_DATA_PATH = config.obsidian.vaultDataPath;

// [[target]], [[target#heading]], [[target|alias]], ![[embed]]
const WIKILINK = /!?\[\[([^\]|#^]+)([^\]]*)\]\]/g;
// [text](href) and ![alt](href), with optional "title". Groups: opening, <angle bracket href>, plain href, closing.
const MDLINK = /(!?\[[^\]]*\]\()(?:<([^>]+)>|([^)\s]+))((?:\s+"[^"]*")?\))/g;
const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:/i;

function normalizeLinkTarget(target: string) {
  return posix.normalize(target.trim().replace(/\.md$/i, "")).replace(/^(\.\/|\/)+/, "");
}

/**
 * Whether a link target refers to the note with the given vault path (without extension). Like Obsidian, a link can
 * use the note's name alone, or any trailing part of its path. Errs towards matching.
 */
function linkResolvesTo(target: string, name: string) {
  const t = posix.normalize(target.trim().replace(/\.md$/i, "")).replace(/^(\.\/|\/)+/, "").toLowerCase();
  const n = name.toLowerCase();
  return t === n || n.endsWith(`/${t}`);
}

/**
 * The note (vault path without extension) a link target refers to, given every note's name: an exact path, or else the
 * one note whose path ends with the target, preferring one in the linking note's folder. Null if no note matches, or
 * several match equally.
 */
function resolveLink(target: string, source: string, names: string[]): string | null {
  const t = normalizeLinkTarget(target).toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === t);
  if (exact) return exact;
  const candidates = names.filter((n) => n.toLowerCase().endsWith(`/${t}`));
  if (candidates.length <= 1) return candidates[0] ?? null;
  const sameFolder = candidates.filter((n) => posix.dirname(n) === posix.dirname(source));
  return sameFolder.length === 1 ? sameFolder[0] : null;
}

export interface RenameResult {
  /** Notes whose links were rewritten, by their path after the rename */
  updated: string[];
  /** Number of links rewritten */
  links: number;
  /** Links which might refer to the renamed note, but match another note just as well, so were left alone */
  ambiguous: { note: string; link: string }[];
}

export interface NoteEntry {
  path: string;
  data: string;
  createdAt: Date;
  updatedAt: Date;
}

export class Obsidian {
  onUpdateListeners: ((path: string) => void)[] = [];
  frontmatterCache: Map<string, Record<string, unknown> | null> = new Map();
  ready: Promise<void>;

  constructor() {
    this.ready = this.initFrontmatterCache();

    watch(
      VAULT_DATA_PATH,
      {
        recursive: true,
        filter(f, skip) {
          // skip dotfiles/folders
          if (/^\./.test(f)) return skip;
          // only watch for md files
          return /\.md$/.test(f);
        },
      },
      (evt, name) => {
        if (evt === "update") {
          const partialName = name.substring(VAULT_DATA_PATH.length + 1);
          this.onUpdateListeners.forEach((listener) => listener(partialName));
        }
      },
    );
    this.onFileChanged((path) => DEBUG(`${path} updated.`));
    this.onFileChanged(async (path) => {
      if (!path.endsWith(".md")) return;
      DEBUG(`Updating frontmatter cache for ${path}`);
      this.frontmatterCache.set(path, await this.noteReadFrontmatter(path));
    });
  }

  private async initFrontmatterCache(): Promise<void> {
    DEBUG("Initializing frontmatter cache...");
    const paths = await this.noteList();
    const mdPaths = paths.filter((p) => p.endsWith(".md"));
    await Promise.all(
      mdPaths.map(async (path) => {
        this.frontmatterCache.set(path, await this.noteReadFrontmatter(path));
      }),
    );
    DEBUG(
      `Frontmatter cache initialized with ${this.frontmatterCache.size} entries.`,
    );
  }

  noteFilterByFrontmatter(
    predicate: (frontmatter: Record<string, unknown> | null) => boolean,
  ): string[] {
    const results: string[] = [];
    for (const [path, frontmatter] of this.frontmatterCache) {
      if (predicate(frontmatter)) results.push(path);
    }
    return results;
  }

  onFileChanged(listener: (path: string) => void) {
    this.onUpdateListeners.push(listener);
  }

  async noteList(): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          results.push(relative(VAULT_DATA_PATH, fullPath));
        }
      }
    };
    await walk(VAULT_DATA_PATH);
    return results;
  }

  async noteReadFrontmatter(
    path: string,
  ): Promise<Record<string, unknown> | null> {
    if (!(await this.noteExists(path))) return null;
    if (!path.endsWith(".md")) return null;
    const fullPath = join(VAULT_DATA_PATH, path);

    try {
      const stream = createReadStream(fullPath);
      const rl = createRlInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      // Check if file starts with ---
      for await (const line of rl) {
        if (line.trim() === "---") break;
        rl.close();
        stream.close();
        return null;
      }

      const fmLines: string[] = [];
      for await (const line of rl) {
        if (line.trim() === "---") break;
        fmLines.push(line);
      }

      rl.close();
      stream.close();

      return YAML.parse(fmLines.join(`\n`)) as Record<string, unknown>;
    } catch (ex) {
      DEBUG(ex);
      return null;
    }
  }

  async noteGetModifiedTime(path: string): Promise<number> {
    const fullPath = join(VAULT_DATA_PATH, path);
    try {
      const stat = await fs.stat(fullPath);
      return stat.mtime.getTime();
    } catch {
      return 0;
    }
  }

  async noteRead(path: string): Promise<string | null> {
    try {
      return await fs.readFile(join(VAULT_DATA_PATH, path), "utf-8");
    } catch {
      return null;
    }
  }

  async noteWrite(path: string, data: string): Promise<void> {
    const fullPath = join(VAULT_DATA_PATH, path);
    await fs.mkdir(dirname(fullPath), { recursive: true });
    DEBUG(`Writing ${path}`);
    await fs.writeFile(fullPath, data, "utf-8");
  }

  async noteReadMulti(paths: string[]): Promise<NoteEntry[]> {
    const results = await Promise.all(
      paths.map(async (path): Promise<NoteEntry | null> => {
        const fullPath = join(VAULT_DATA_PATH, path);
        try {
          const [data, stat] = await Promise.all([
            fs.readFile(fullPath, "utf-8"),
            fs.stat(fullPath),
          ]);
          return {
            path,
            data,
            createdAt: stat.birthtime,
            updatedAt: stat.mtime,
          };
        } catch {
          return null;
        }
      }),
    );
    return results.filter(Boolean) as NoteEntry[];
  }

  async noteDelete(path: string): Promise<void> {
    DEBUG(`Deleting ${path}`);
    await fs.unlink(join(VAULT_DATA_PATH, path));
    this.frontmatterCache.delete(path);
  }

  /**
   * Renames or moves a note, and rewrites links to it as Obsidian does: wikilinks, embeds, and markdown links, keeping
   * each link's style (name only, full path, or relative). Relative links in the moved note itself are updated too.
   */
  async noteRename(from: string, to: string): Promise<RenameResult> {
    if (!(await this.noteExists(from))) throw new Error(`Note not found: ${from}`);
    // A change of case alone is fine, even on a case-insensitive filesystem where the new path already "exists".
    if (from.toLowerCase() !== to.toLowerCase() && (await this.noteExists(to)))
      throw new Error(`A note already exists at ${to}`);

    const files = (await this.noteList()).filter((p) => !p.split("/").some((s) => s.startsWith(".")));
    const notes = files.filter((p) => p.endsWith(".md"));
    const fromName = from.replace(/\.md$/, "");
    const toName = to.replace(/\.md$/, "");
    const before = notes.map((p) => p.replace(/\.md$/, ""));
    // Anything a markdown link can point at: notes (without extension), and attachments.
    const linkable = new Set([...before, ...files.filter((p) => !p.endsWith(".md"))]);
    const after = before.map((n) => (n === fromName ? toName : n));
    const toShort = toName.split("/").pop()!;
    // Name-only links stay name-only, unless the new name is shared with another note.
    const shortOrFull = (source: string) => (resolveLink(toShort, source, after) === toName ? toShort : toName);

    const result: RenameResult = { updated: [], links: 0, ambiguous: [] };
    const writes: [string, string][] = [];
    for (const source of notes) {
      const data = await this.noteRead(source);
      if (data === null) continue;
      const newSource = source === from ? to : source;
      let links = 0;

      let updated = data.replace(WIKILINK, (link, target: string) => {
        const resolved = resolveLink(target, source, before);
        if (resolved !== fromName) {
          if (resolved === null && linkResolvesTo(target, fromName)) result.ambiguous.push({ note: newSource, link });
          return link;
        }
        links++;
        const ext = /\.md\s*$/i.test(target) ? ".md" : "";
        const newTarget = target.includes("/") ? toName : shortOrFull(newSource);
        return link.replace(`[[${target}`, () => `[[${newTarget}${ext}`);
      });

      updated = updated.replace(MDLINK, (link, open: string, angle: string | undefined, plain: string | undefined, close: string) => {
        const href = angle ?? plain!;
        if (EXTERNAL_URL.test(href)) return link;
        const hash = href.indexOf("#");
        const anchor = hash === -1 ? "" : href.slice(hash);
        let path = hash === -1 ? href : href.slice(0, hash);
        if (!path) return link; // A heading in the same note
        try {
          if (!angle) path = decodeURIComponent(path);
        } catch {
          return link;
        }

        // Obsidian writes markdown links relative to the linking note, from the vault root, or by shortest path.
        const relative = normalizeLinkTarget(posix.join(posix.dirname(source), path));
        const style = linkable.has(relative) ? "relative" : linkable.has(normalizeLinkTarget(path)) ? "root" : "shortest";
        const resolved = style === "relative" ? relative : resolveLink(path, source, before);
        if (resolved === null) {
          if (linkResolvesTo(path, fromName)) result.ambiguous.push({ note: newSource, link });
          return link;
        }
        const targetMoved = resolved === fromName;
        if (!targetMoved && (style !== "relative" || newSource === source)) return link;

        const newTarget = targetMoved ? toName : resolved;
        let newPath =
          style === "relative"
            ? posix.relative(posix.dirname(newSource), newTarget)
            : style === "root"
              ? newTarget
              : shortOrFull(newSource);
        if (/\.md$/i.test(path)) newPath += ".md";
        links++;
        return `${open}${angle ? `<${newPath}${anchor}>` : `${newPath.replace(/ /g, "%20")}${anchor}`}${close}`;
      });

      if (updated !== data) writes.push([newSource, updated]);
      if (links > 0) {
        result.updated.push(newSource);
        result.links += links;
      }
    }

    DEBUG(`Renaming ${from} to ${to}, updating ${result.links} links in ${result.updated.length} notes.`);
    await fs.mkdir(dirname(join(VAULT_DATA_PATH, to)), { recursive: true });
    await fs.rename(join(VAULT_DATA_PATH, from), join(VAULT_DATA_PATH, to));
    this.frontmatterCache.set(to, this.frontmatterCache.get(from) ?? null);
    if (from !== to) this.frontmatterCache.delete(from);
    for (const [path, data] of writes) await this.noteWrite(path, data);
    return result;
  }

  /** Paths of notes which link to the given note, via wikilinks, embeds, or markdown links. */
  async noteBacklinks(path: string): Promise<string[]> {
    const name = path.replace(/\.md$/, "");
    const notes = (await this.noteList()).filter(
      (p) => p.endsWith(".md") && p !== path && !p.split("/").some((s) => s.startsWith(".")),
    );
    const linking = await Promise.all(
      notes.map(async (p) => {
        const data = await this.noteRead(p);
        if (!data) return false;
        for (const [, target] of data.matchAll(WIKILINK)) {
          if (linkResolvesTo(target, name)) return true;
        }
        for (const [, , angle, plain] of data.matchAll(MDLINK)) {
          const href = angle ?? plain;
          if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // External URL
          let target: string;
          try {
            target = decodeURIComponent(href.split("#")[0]);
          } catch {
            continue;
          }
          // Markdown links may be relative to the linking note, or to the vault root.
          if (
            linkResolvesTo(target, name) ||
            linkResolvesTo(posix.join(posix.dirname(p), target), name)
          )
            return true;
        }
        return false;
      }),
    );
    return notes.filter((_, i) => linking[i]);
  }

  async noteExists(path: string): Promise<boolean> {
    try {
      await fs.access(join(VAULT_DATA_PATH, path));
      return true;
    } catch {
      return false;
    }
  }
}
