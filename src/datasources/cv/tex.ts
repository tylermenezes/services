import { UnionToIntersection } from '@/utils';
import { CvList, fetchCv } from './parse';

type CvEntry = { title: string, items: CvList };

function* cvListItemToTex(
  item: Partial<UnionToIntersection<CvList[number]>>
): Generator<string> {
  if (item.cite) {
    yield item.cite
      .replace(/\.$/, '')
      .replace(item.title || 'IGNOREME', `\\textbf{${item.title}}`);
    return;
  }

  if (item.interval) yield item.interval;
  else if (item.date) yield item.date;
  
  if (item.role && item.company) yield `\\textbf{${item.role}, ${item.company}}`;
  if (item.degree && item.school) yield `${item.degree}, ${item.school}`;
  if (item.title) yield `\\textbf{\`\`${item.title}''}`;

  if (item.outlet) yield item.outlet;
  if (item.venue) yield item.venue;

  if (item.blurb && (item as { type: string }).type === 'role') {
    yield ' \\\\\n\t\\begin{sublist}\n' + item.blurb.trim()
      .replace(/ *[\-\*] +/g, `\t\\item `)
      + '\n\t\\end{sublist}'
  } else if (item.blurb) yield item.blurb;
}

function cvListToTex(list: CvList): string {
  return list
    .map(i => 
      '\\item '
      + [...cvListItemToTex(i)]
        .join('. ')
        .replace(/\&/g, '\\&')
        .replace(/\$/g, '\\$')
        .replace(/\%/g, '\\%')
        .replace(/\#/g, '\\#')
        .replace(/(https?:\/\/[\w\.\/\?]+)/g, '\\href{$1}{$1}')
        .trim()
    )
    .map(i => ['.', '}'].includes(i.slice(-1)) ? i : `${i}.`)
    .join('\n');
}

export async function fetchCvTex() {
  const entries = await fetchCv();
  if (!entries) return null;
  
  const sections: CvEntry[] = [
    {
      title: 'Work',
      items: entries.roles,
    },
    {
      title: 'Education',
      items: entries.education,
    },
    {
      title: 'Publications',
      items: entries.publications,
    },
    {
      title: 'Grants',
      items: entries.grants,
    },
    {
      title: 'Professional Service',
      items: entries.service,
    },
    {
      title: 'Lectures, Talks, Workshops',
      items: entries.talksInterviews,
    },
    {
      title: 'Affiliations',
      items: entries.affiliations,
    },
    {
      title: 'Press',
      items: entries.press,
    },
    {
      title: 'Volunteering',
      items: entries.volunteering,
    },
  ];

  const texBody = sections
    .map(({ title, items }) => {
      const itemTex = cvListToTex(items).trim();
      if (itemTex.length === 0) return '';
      return `\\section{${title}}\n\\begin{cvlist}\n${itemTex}\n\\end{cvlist}`;
    })
    .join(`\n\n`);

  const bio = (entries.bio || '').replace(/\[([^\[\]]+)\]\(([^\(\)]+)\)/g, "\\href{$2}{$1}");
  const tex = (bio ? `\\section{Biography}\n${bio}\\vspace{0.25in}\n\n` : '') + texBody;

  return tex;
}