import Nano from "nano";
import { createHash } from "crypto";
import { DateTime } from "luxon";

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
}

interface NoteLeafDocument {
  _id: string
  _rev?: string
  data: string
  type: 'leaf'
}

export class Obsidian {
  private nano: Nano.DocumentScope<unknown>;

  constructor(url: string, db: string) {
    this.nano = Nano(url).use(db);
  }

  async noteWrite(path: string, data: string) {
    const mtime = DateTime.now().toUnixInteger();
    const leafDoc: NoteLeafDocument = {
      _id: 'h:' + createHash('sha1').update(data).digest('base64').slice(0,13),
      type: 'leaf',
      data,
    };
    const pointerDoc: NotePointerDocument = {
      _id: path,
      path,
      ctime: mtime,
      mtime,
      size: data.length,
      type: 'plain',
      children: [leafDoc._id],
      eden: {}
    }

    try {
      const existingNote = await this.nano.get(path) as NotePointerDocument;
      pointerDoc._rev = existingNote._rev;
      pointerDoc.ctime = existingNote.ctime;
    } catch (ex) {}

    await this.nano.insert(leafDoc);
    await this.nano.insert(pointerDoc);
  }

  async noteRead(path: string) {
    try {
      const { children: childrenPaths } = await this.nano.get(path) as NotePointerDocument;
      const children = await Promise.all(
        childrenPaths.map(p => this.nano.get(p) as Promise<NoteLeafDocument>)
      );
      return children.map(c => c.data).join('');
    } catch (ex) { return null; }
  }

  async noteExists(path: string) {
    try {
      await this.nano.get(path) as NotePointerDocument;
      return true;
    } catch (ex) { return false; }
  }
}