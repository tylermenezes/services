import { Content } from 'mdast';
import { treeToString } from "@/utils";

export interface OpenSource { url: string | null, title: string | null, description: string | null };
export function parseOpenSource(content: Content[]): OpenSource {
  const link = content[0].type === 'heading' && (content[0].children as Content[])?.filter(c => c.type === 'link')[0];
  const url = link && link.type === 'link' && link.url || null;
  const title = treeToString([content[0]]);
  const description = treeToString([content[1]]);
  return { url, title, description };
}
