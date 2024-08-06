import { Content, Paragraph } from 'mdast';
import { HeadingTree, treeToString } from "@/utils";

export interface Publication { url: string | null, title: string | null, conference: string | null, date: string | null, authors: string | null, cite: string | null, abstract: string | null, recommended: boolean }; 
export function parsePublication(_content: Content[] | HeadingTree): Publication {
  const content = '_' in _content ? _content._ as Content[] : _content as Content[];
  const link = content[0].type === 'heading' && (content[0].children as Content[])?.filter(c => c.type === 'link')[0];
  const url = link && link.type === 'link' && link.url || null;
  const title = treeToString([content[0]]);

  const infoNode = content[1].type === 'paragraph' && content[1];
  const citeNode = 'Citation' in _content
    ? (_content.Citation as Content[])[1].type === 'paragraph' && (_content.Citation as Content[])[1] as Paragraph
    : null;
  const abstractNode = 'Abstract' in _content
    ? (_content.Abstract as Content[])[1].type === 'paragraph' && (_content.Abstract as Content[])[1] as Paragraph
    : null;

  const [conference, date] = infoNode ? treeToString(infoNode.children.slice(0, 2)).split(', ').map(e => e.trim()) : [];
  const authors = infoNode ? treeToString(infoNode.children.slice(3,4)).trim() : null;
  const recommended = infoNode ? treeToString(infoNode.children.slice(5,6)).toLowerCase().trim().includes('recommended') : false;
  const cite = citeNode ? treeToString(citeNode.children).trim() : null;
  const abstract = abstractNode ? treeToString(abstractNode.children).trim() : null;
  return { url, title, conference, date, authors, recommended, cite, abstract };
}
