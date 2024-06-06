import { Content } from 'mdast';
import { renderMarkdown, treeToString, valuesRecursive } from "@/utils";

export interface WorkExperience { role: string | null, company: string | null, interval: string | null, blurb: string | null };
export function parseWorkExperience(content: Content[]): WorkExperience {
  const company = treeToString([content[0]]);
  const [role, interval] = treeToString([content[1]]).split(' , ').map(e => e.trim());
  const blurb = renderMarkdown(valuesRecursive(content.slice(2)));
  return { role, company, interval, blurb };
}
