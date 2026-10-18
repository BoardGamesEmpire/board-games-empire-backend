import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { withScheme } from './url';

/**
 * HTML as a Markdown tree, parsed as a browser would parse it. Elements
 * Markdown has an equivalent for, such as paragraphs, emphasis, lists and
 * links, become it. Scripts, styles and the like are dropped, and any other
 * element leaves its text. An HTML comment survives as raw HTML, which
 * sanitizing strips.
 */
export function htmlTree(html: string): Root {
  // A root converts to a root.
  const tree = toMdast(fromHtml(html, { fragment: true })) as Root;

  visit(tree, (node) => {
    if (node.type === 'link' || node.type === 'image') {
      node.url = withScheme(node.url);
    }
  });

  return tree;
}
