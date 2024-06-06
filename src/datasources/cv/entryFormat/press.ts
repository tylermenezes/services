import { Content } from 'mdast';
import { treeToString } from "@/utils";

export interface Press { url: string | null, title: string | null, outlet: string | null, date: string | null, recommended: boolean };
export function parsePress(content: Content[]): Press {
  const link = content[0].type === 'heading' && (content[0].children as Content[])?.filter(c => c.type === 'link')[0];
  const url = link && link.type === 'link' && link.url || null;
  const title = treeToString([content[0]]);

  const infoNode = content[1].type === 'paragraph' && content[1];

  const [outlet, date] = infoNode ? treeToString(infoNode.children.slice(0, 2)).split(', ').map(e => e.trim()) : [];
  const recommended = infoNode ? treeToString(infoNode.children.slice(3)).toLowerCase().trim().includes('recommended') : false;
  return { url, title, outlet, date, recommended };
}
