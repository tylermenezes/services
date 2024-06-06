import { unified } from 'unified'
import { Content, FrontmatterContent } from 'mdast'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import { toMarkdown } from 'mdast-util-to-markdown';
import { parse } from 'yaml';

export function markdownParse(markdown: string) {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .parse(markdown).children;
}

export function markdownFrontmatter<T>(markdown: string): T {
  const fmContent = markdownParse(markdown)
    .find(c => c.type === 'yaml') as FrontmatterContent;
  return parse(
      fmContent.value || ''
  );
}

export function renderMarkdown(content: Content[]) {
  return toMarkdown({ type: 'root', children: content as any });
}