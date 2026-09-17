import { Content } from 'mdast';
import { treeToString } from "@/utils";

export interface Certification { title: string | null, sponsor: string | null, date: string | null };
export function parseCertification(content: Content[]): Certification | null {
  try {
    const title = treeToString([content[0]]);

    const infoNode = content[1].type === 'paragraph' && content[1];
    const [sponsor, date] = infoNode ? treeToString(infoNode.children.slice(0, 2)).split(', ').map(e => e.trim()) : [];

    return { title, sponsor, date };
  } catch (ex) {
    console.error(ex, content);
    return null;
  }
}
