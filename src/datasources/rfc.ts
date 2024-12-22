import { obsidian, NoteEntry } from '@/clients';
import { markdownFrontmatter, markdownParse } from '@/utils';
import { DateTime } from 'luxon';
import { Heading, Text } from 'mdast';
import schedule from 'node-schedule';
import debug from 'debug';

const DEBUG = debug('services:datasources:rfc');

interface NoteEnhance {
  title: string
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
  DEBUG('Updating RFCs.');
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
      const md = markdownParse(n.data);
      const h1 = md.find(n => n.type === 'heading' && (n as Heading).depth === 1) as Heading | undefined;
      if (!h1) return null;
      return {
        title: h1.children.map(c => (c as Text).value).join(' '),
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
    .filter((note) => note && !!note.publish) as (NoteEntry & NoteEnhance)[];
    DEBUG(`${notes.length} RFCs fetched.`);
}

export async function scheduleRfcUpdate() {
  await rfcUpdate();
  const job = schedule.scheduleJob('7 * * * *', rfcUpdate);
}