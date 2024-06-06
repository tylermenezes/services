import { Content } from 'mdast'

export interface HeadingTree {
  [key: string]: Content[] | HeadingTree
}

export function treeToString(nodes?: Content[] | Content | string): string {
  if (typeof nodes === 'undefined' || nodes === null) return '';
  if (typeof nodes === 'string') return nodes;
  if (!Array.isArray(nodes)) return treeToString([nodes]);
  return nodes
    .map(node => (node.type === 'text' ? node.value : '') + ('children' in node ? treeToString(node.children) : ''))
    .filter(Boolean)
    .join(' ');
}

export function treeReorganizeByHeading(nodes: Content[]): HeadingTree | Content[] {
  if (nodes.length === 0) return [];
  let depth = null;

  const headings: [string, Content[]][] = [['_', [nodes[0]]]];

  for (const node of nodes.slice(1)) {
    if (node.type === 'heading' && (!depth || node.depth === depth)) {
      depth = node.depth;
      headings.push([treeToString(node.children), [node]]);
    } else {
      headings[headings.length - 1][1].push(node);
    }
  }

  if (depth === null) return nodes;

  const out = headings
    .filter(([,innerNodes]) => innerNodes.length > 0)
    .map(([heading, innerNodes]) => [heading, treeReorganizeByHeading(innerNodes)]);

  return Object.fromEntries(out);
}

export function valuesRecursive(tree: HeadingTree | Content[] | null): Content[] {
  if (Array.isArray(tree) || typeof tree !== 'object' || !tree) return tree || [];
  return Object.values(tree).map(e => valuesRecursive(e) as unknown as Content);
}