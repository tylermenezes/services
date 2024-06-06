import { unified } from 'unified'
import { Content } from 'mdast'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import { toMarkdown } from 'mdast-util-to-markdown';

export async function markdownParse(markdown: string) {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .parse(markdown).children;
}

export function renderMarkdown(content: Content[]) {
  return toMarkdown({ type: 'root', children: content as any });
}