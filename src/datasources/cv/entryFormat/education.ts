import { Content } from 'mdast';
import { treeToString } from "@/utils";

export interface Education { school: string | null, degree: string | null, interval: string | null}
export function parseEducation(content: Content[]): Education | null {
  try {
    const school = treeToString([content[0]]);
    const [degree, interval] = treeToString([content[1]]).split(', ').map(e => e.trim());
    return { school, degree, interval };
  } catch (ex) {
    console.error(ex, content);
    return null;
  }
}
