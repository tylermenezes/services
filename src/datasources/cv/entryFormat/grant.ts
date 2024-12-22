import { Content } from 'mdast';
import { treeToString, valuesRecursive } from "@/utils";

export interface Grant { title: string | null, sponsor: string | null, date: string | null, recommended: boolean, url: string | null,  authors: string | null };
export function parseGrants(content: Content[]): Grant {
  const link = content[0].type === 'heading' && (content[0].children as Content[])?.filter(c => c.type === 'link')[0];
  const url = link && link.type === 'link' && link.url || null;
  const title = treeToString([content[0]]);

  const infoNode = content[1].type === 'paragraph' && content[1];

  const [sponsor, date] = infoNode ? treeToString(infoNode.children.slice(0, 2)).split(', ').map(e => e.trim()) : [];
  const recommended = infoNode ? treeToString(infoNode.children.slice(2,3)).toLowerCase().trim().includes('recommended') : false;
  const authors = treeToString(valuesRecursive(content.slice(2)));
  return { title, sponsor, date, recommended, url, authors };
}
