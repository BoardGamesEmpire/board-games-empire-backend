import type { Nodes, Parents, Root, Text } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { type Handle, toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';

/**
 * Containers dropped when nothing is left in them. Written out empty, some
 * would read back as something else: `~~~~` opens a code fence, and `****`
 * is a rule.
 */
const DROPPED_WHEN_EMPTY: ReadonlySet<string> = new Set([
  'blockquote',
  'delete',
  'emphasis',
  'heading',
  'link',
  'linkReference',
  'list',
  'listItem',
  'paragraph',
  'strong',
]);

/**
 * Stored descriptions are CommonMark with GitHub's extensions (tables,
 * strikethrough, task lists, footnotes and bare links), so one Markdown
 * renderer shows them all (#709). Every conversion reads and writes them
 * through these two.
 */
export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/**
 * Writes the tree as Markdown, dropping containers left empty. Text is
 * escaped wherever Markdown would read it as syntax, so the output reads
 * back as the same tree.
 *
 * `*` for emphasis because `_` can't open or close inside a word, and a
 * converted `x[i]y[/i]z` needs it to. The serializer ends with a newline,
 * which a stored description doesn't need.
 */
export function serializeMarkdown(tree: Root): string {
  dropEmpty(tree);

  const markdown = toMarkdown(tree, {
    extensions: [gfmToMarkdown()],
    handlers: { text },
    bullet: '-',
    emphasis: '*',
    strong: '*',
    fences: true,
    rule: '-',
    listItemIndent: 'one',
  });

  return markdown.endsWith('\n') ? markdown.slice(0, -1) : markdown;
}

/**
 * The serializer's own text handler, except in how it finds the node among
 * its siblings. The serializer's searches for it, so a paragraph of n nodes
 * takes time in n squared: 256 KB of one-letter lines, as plain text, took
 * 8 s. This looks first where the serializer is, or at the node after, which
 * it reads to know what comes next.
 */
const text: Handle = (node: Text, parent, state, info) => {
  const siblings: readonly Nodes[] = parent?.children ?? [];
  const at = state.indexStack.at(-1) ?? -1;
  const index = [at, at + 1].find((candidate) => siblings[candidate] === node) ?? siblings.indexOf(node);

  return state.safe(node.value, { ...info, afterNode: siblings[index + 1], beforeNode: siblings[index - 1] });
};

/** Whether `node` is a container that's dropped for having nothing in it. */
export function isEmptyContainer(node: Nodes): boolean {
  return 'children' in node && node.children.length === 0 && DROPPED_WHEN_EMPTY.has(node.type);
}

/** Removes empty containers under `parent`, innermost first, so a list of empty items goes too. */
function dropEmpty(parent: Parents): void {
  parent.children = parent.children.filter((child) => {
    if ('children' in child) {
      dropEmpty(child);
    }
    return !isEmptyContainer(child);
  }) as typeof parent.children;
}
