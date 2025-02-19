import Nano from "nano";
import { createHash } from "crypto";
import { DateTime } from "luxon";
import debug from "debug";

const DEBUG = debug('services:clients:obsidian');

interface NotePointerDocument { 
  _id: string
  _rev?: string
  path: string,
  ctime: number
  mtime: number
  size: number
  type: string
  children: string[]
  eden: {}
  deleted?: boolean
}

interface NoteLeafDocument {
  _id: string
  _rev?: string
  data: string
  type: 'leaf'
}

export interface NoteEntry {
  path: string
  data: string
  createdAt: Date
  updatedAt: Date
}

export class Obsidian {
  private nano: Nano.DocumentScope<unknown>;

  constructor(url: string, db: string) {
    this.nano = Nano(url).use(db);
  }

  async noteList() {
    const result = (await this.nano.find({
      selector: { '$not': { type: 'leaf' } },
      limit: 10000,
      fields: ['path']
    })).docs as unknown as { path: string }[];
    return result.map(d => d.path).filter(Boolean);
  }

  async noteWrite(path: string, data: string) {
    const mtime = DateTime.now().toUnixInteger();
    const leafDoc: NoteLeafDocument = {
      _id: 'h:' + createHash('sha1').update(data).digest('base64').slice(0,13).toLowerCase(),
      type: 'leaf',
      data,
    };
    const pointerDoc: NotePointerDocument = {
      _id: path.toLowerCase(),
      path,
      ctime: mtime,
      mtime,
      size: data.length,
      type: 'plain',
      children: [leafDoc._id],
      eden: {}
    }

    try {
      const existingPointer = await this.nano.get(path.toLowerCase()) as NotePointerDocument;
      pointerDoc._rev = existingPointer._rev;
      pointerDoc.ctime = existingPointer.ctime;
    } catch (ex) {}

    try {
      const existingLeaf = await this.nano.get(leafDoc._id.toLowerCase()) as NoteLeafDocument;
      leafDoc._rev = existingLeaf._rev;
    } catch (ex) {}

    DEBUG(`Writing ${leafDoc._id}`);
    await this.nano.insert(leafDoc);
    DEBUG(`Writing ${pointerDoc._id}`);
    await this.nano.insert(pointerDoc);
  }

  async noteRead(path: string) {
    try {
      const { children: childrenPaths } = await this.nano.get(path.toLowerCase()) as NotePointerDocument;
      const children = await Promise.all(
        childrenPaths.map(p => this.nano.get(p.toLowerCase()) as Promise<NoteLeafDocument>)
      );
      return children.map(c => c.data).join('');
    } catch (ex) { return null; }
  }

  async noteReadMulti(paths: string[]): Promise<NoteEntry[]> {
    const pointers = (await this.nano.fetch({ keys: paths }))
      .rows
      .filter(r => !r.error)
      .map(r => (r as Nano.DocumentResponseRow<NotePointerDocument>).doc!);

    const leafIds = pointers.flatMap(p => p.children);
    const leaves = Object.fromEntries(
      (await this.nano.fetch({ keys: leafIds }))
        .rows
        .filter(r => !r.error)
        .map(r => (r as Nano.DocumentResponseRow<NoteLeafDocument>).doc!)
        .map(r => [r._id, r.data])
    );

    return pointers
      .map((p) => ({
        path: p._id,
        data: p.children.map(c => leaves[c]!).join(''),
        createdAt: DateTime.fromMillis(p.ctime).toJSDate(),
        updatedAt: DateTime.fromMillis(p.mtime).toJSDate(),
      }));
  }

  async noteExists(path: string) {
    try {
      const result = await this.nano.get(path.toLowerCase()) as NotePointerDocument;
      if (result.deleted) return !result.deleted;
      return true;
    } catch (ex) { }
    return false;
  }
}