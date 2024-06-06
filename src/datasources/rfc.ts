import { obsidian } from '@/services';
import { NoteEntry } from '@/services/Obsidian';
import { markdownFrontmatter, markdownParse } from '@/utils';
import { DateTime } from 'luxon';
import schedule from 'node-schedule';

interface NoteEnhance {
  tags: string[]
  image?: string
  slug: string
  publish: boolean
  unlisted: boolean
}
let notes: (NoteEntry & NoteEnhance)[] = [];

export function getRfcs() {
  return notes;
}

export async function rfcUpdate() {
  const rfcNoteNames = (await obsidian.noteList())
    .filter(n => n.startsWith('rfc/'));

  notes = (await obsidian.noteReadMulti(rfcNoteNames))
    .map(n => {
      const fm = markdownFrontmatter<{
        image?: string,
        publish?: boolean,
        unlisted?: boolean,
        date?: string,
      }>(n.data);
      return {
        path: n.path,
        slug: n.path
          .slice('rfc/'.length)
          .replace('.md', '')
          .replace(/[^a-z0-9\-]/g, '-')
          .replace(/--+/g, '-'),
        data: n.data,
        image: fm.image,
        publish: fm.publish || false,
        unlisted: fm.unlisted || false,
        createdAt: (fm.date ? DateTime.fromISO(fm.date).toJSDate() : n.createdAt) || n.createdAt,
        updatedAt: n.updatedAt,
        tags: ([...n.data.matchAll(/#[a-zA-Z-\_]+/g)] as string[][])
          .flatMap(e => e[0].slice(1))
          .filter(t => t !== 'rfc'),
      };
    })
    .filter(({ publish }) => !!publish);
}

export async function scheduleRfcUpdate() {
  await rfcUpdate();
  const job = schedule.scheduleJob('*/5 * * * *', rfcUpdate);
}