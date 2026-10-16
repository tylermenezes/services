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
// [text](href) and ![alt](href), with optional <angle brackets> or "title"
const MDLINK = /!?\[[^\]]*\]\(<?([^)<>\s]+)>?(?:\s+"[^"]*")?\)/g;

/**
 * Whether a link target refers to the note with the given vault path (without extension). Like Obsidian, a link can
 * use the note's name alone, or any trailing part of its path. Errs towards matching.
 */
function linkResolvesTo(target: string, name: string) {
  const t = posix.normalize(target.trim().replace(/\.md$/i, "")).replace(/^(\.\/|\/)+/, "").toLowerCase();
  const n = name.toLowerCase();
  return t === n || n.endsWith(`/${t}`);
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

  /** Renames a note and rewrites wikilinks to it in other notes, as Obsidian does. */
  async noteRename(from: string, to: string): Promise<void> {
    const backlinks = await this.noteBacklinks(from);
    DEBUG(`Renaming ${from} to ${to}, updating links in ${backlinks.length} notes.`);
    await fs.mkdir(dirname(join(VAULT_DATA_PATH, to)), { recursive: true });
    await fs.rename(join(VAULT_DATA_PATH, from), join(VAULT_DATA_PATH, to));
    this.frontmatterCache.set(to, this.frontmatterCache.get(from) ?? null);
    this.frontmatterCache.delete(from);

    const fromName = from.replace(/\.md$/, "");
    const toName = to.replace(/\.md$/, "");
    for (const path of backlinks) {
      const data = await this.noteRead(path);
      if (data === null) continue;
      const updated = data.replace(WIKILINK, (link, target: string, rest: string) => {
        if (!linkResolvesTo(target, fromName)) return link;
        // Keep the link's style: full path if it used one, otherwise just the name.
        const newTarget = target.includes("/") ? toName : toName.split("/").pop()!;
        return link.replace(`[[${target}`, `[[${newTarget}`);
      });
      if (updated !== data) await this.noteWrite(path, updated);
    }
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
        for (const [, href] of data.matchAll(MDLINK)) {
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
