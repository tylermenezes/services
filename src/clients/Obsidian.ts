import { promises as fs, createReadStream } from "fs";
import { createInterface as createRlInterface } from "node:readline/promises";
import { join, dirname, relative } from "path";
import YAML from "yaml";
import debug from "debug";
import watch from "node-watch";
import config from "@/config";

const DEBUG = debug("services:clients:obsidian");
const VAULT_DATA_PATH = config.obsidian.vaultDataPath;

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

  async noteExists(path: string): Promise<boolean> {
    try {
      await fs.access(join(VAULT_DATA_PATH, path));
      return true;
    } catch {
      return false;
    }
  }
}
