import {
  markdownParse,
  renderMarkdown,
  HeadingTree,
  treeReorganizeByHeading,
  valuesRecursive,
} from '@/utils';
import { obsidian } from '@/services';
import config from '@/config';
import {
  SkillBlock,
  WorkExperience,
  Education,
  Publication,
  Press,
  OpenSource,
  Talk,
  Grant,
  parseWorkExperience,
  parseEducation,
  parsePublication,
  parsePress,
  parseGrants,
  parseOpenSource,
  parseTalks,
} from './entryFormat';

type WithType<T, U> = T & { type: U };
export interface Cv {
  bio: string | null
  skills: SkillBlock[]
  roles: WorkExperience[]
  education: Education[]
  volunteering: WorkExperience[]
  service: WorkExperience[]
  affiliations: WorkExperience[]
  publications: Publication[]
  press: Press[]
  openSource: OpenSource[]
  talksInterviews: Talk[]
  grants: Grant[]
}
export type CvList = Cv[keyof Omit<Cv, 'bio' | 'skills'>];

function addTypeKeys<T extends Omit<CvList[number], 'type'>, U>(list: T[], typeKey: U): WithType<T, U>[] {
  return list.map(e => ({ ...e, type: typeKey }));
}

let cvCache: string | null = null;

export async function fetchCv(onlyRecommended = false): Promise<Cv | null> {
  let cvMd = await obsidian.noteRead(config.obsidian.cvNote);
  if (!cvMd && cvCache) {
    cvMd = cvCache!;
    console.error(`CV was not available, loading from cache.`);
  } else if (!cvMd) return null;

  cvCache = cvMd;

  if (cvMd.slice(0,4) === `---\n`) {
    cvMd = cvMd.slice(cvMd.indexOf(`---\n`, 3) + 4)
  }
  cvMd = cvMd.replace(/[“”]/g, '"').replace(/’/g, '\'').replace(/–/g, '-');

  const cv = await markdownParse(cvMd);
  const mdParsed = treeReorganizeByHeading(cv) as HeadingTree;

  const filterRecommended = (e: any) => onlyRecommended ? (e.recommended !== false) : true;
  
  // Extract parts from the markdown
  const bio = renderMarkdown(valuesRecursive(mdParsed.Bio || {}).slice(1));
  const skills = renderMarkdown(valuesRecursive(mdParsed.Skills || {}).slice(1))
    .trim()
    .split(`\n`)
    ?.map(s => s.replace(/\*\*/g, '').split(': '))
    ?.map(([cat, skill]): SkillBlock => [cat.trim() || null, skill?.split(',')?.map(e => e?.trim() || null) || null]);

  const roles = Object.values(mdParsed['Work Experience'] || {}).slice(1).map(parseWorkExperience);
  const education = Object.values(mdParsed['Education'] || {}).slice(1).map(parseEducation);
  const volunteering = Object.values(mdParsed['Volunteering'] || {}).slice(1).map(parseWorkExperience);
  const service = Object.values(mdParsed['Professional Service'] || {}).slice(1).map(parseWorkExperience);
  const affiliations = Object.values(mdParsed['Affiliations and Professional Organizations'] || {}).slice(1).map(parseWorkExperience);
  const publications = Object.values(mdParsed['Publications'] || {}).slice(1).map(parsePublication).filter(filterRecommended);
  const press = Object.values(mdParsed['Press Coverage'] || {}).slice(1).map(parsePress).filter(filterRecommended);
  const grants = Object.values(mdParsed['Research Grants'] || {}).slice(1).map(parseGrants).filter(filterRecommended);
  const openSource = Object.values(mdParsed['Public Work'] || {}).slice(1).map(parseOpenSource);
  const talksInterviews = Object.values(mdParsed['Talks & Interviews'] || {}).slice(1).map(parseTalks).filter(filterRecommended);

  return {
    bio,
    skills,
    roles: addTypeKeys(roles, 'role'),
    education: addTypeKeys(education, 'education'),
    volunteering: addTypeKeys(volunteering, 'volunteering'),
    publications: addTypeKeys(publications, 'publication'),
    press: addTypeKeys(press, 'press'),
    openSource: addTypeKeys(openSource, 'openSource'),
    talksInterviews: addTypeKeys(talksInterviews, 'talk'),
    service: addTypeKeys(service, 'service'),
    grants: addTypeKeys(grants, 'grants'),
    affiliations: addTypeKeys(affiliations, 'affiliations'),
  };
}