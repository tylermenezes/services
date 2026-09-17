import { Content } from 'mdast';
import { treeToString, valuesRecursive } from "@/utils";

export interface HumanSubjectsResearch { title: string | null, sponsor: string | null, date: string | null, blurb: string | null };
export function parseHumanSubjectsResearch(content: Content[]): HumanSubjectsResearch | null {
  try {
    const title = treeToString([content[0]]);

    const infoNode = content[1].type === 'paragraph' && content[1];
    const [sponsor, date] = infoNode ? treeToString(infoNode.children.slice(0, 2)).split(', ').map(e => e.trim()) : [];

    const blurb = treeToString(valuesRecursive(content.slice(2)));

    return { title, sponsor, date, blurb };
  } catch (ex) {
    console.error(ex, content);
    return null;
  }
}
