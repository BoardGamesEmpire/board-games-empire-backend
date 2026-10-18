import type { Paragraph, PhrasingContent, Root } from 'mdast';
import { serializeMarkdown } from './markdown';
import { trimPhrasing } from './phrasing';

/** A line holding nothing but spaces or tabs, between two others. */
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * Plain text as Markdown: nothing in it is read as syntax. A `#1` starting a
 * line stays text rather than becoming a heading, `*` stays an asterisk, and
 * an `&` that starts something like `&amp;` stays an ampersand. Only a bare
 * web or email address becomes a link, as Markdown makes it however it's
 * escaped; it shows as written.
 *
 * Line breaks are kept: a blank line starts a new paragraph, and a single
 * newline becomes a hard break. Spaces and tabs at either end of a line are
 * dropped, since Markdown can't show them.
 */
export function plainTextToMarkdown(text: string): string {
  return serializeMarkdown(plainTextTree(text));
}

export function plainTextTree(text: string): Root {
  return { type: 'root', children: toParagraphs([{ type: 'text', value: text }]) };
}

/**
 * Splits phrasing into paragraphs by the newlines in its text: a blank line
 * ends a paragraph, and a single newline becomes a hard break. Only the text
 * nodes given are split; a newline inside another node, such as emphasis, is
 * that node's to deal with.
 */
export function toParagraphs(phrasing: readonly PhrasingContent[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: PhrasingContent[] = [];

  const endParagraph = () => {
    const children = trimPhrasing(current);
    if (children.length > 0) {
      paragraphs.push({ type: 'paragraph', children });
    }
    current = [];
  };

  for (const node of phrasing) {
    if (node.type !== 'text') {
      current.push(node);
      continue;
    }

    normalizeNewlines(node.value)
      .split(BLANK_LINE)
      .forEach((block, blockIndex) => {
        if (blockIndex > 0) {
          endParagraph();
        }

        // One at a time: spread into push, a long text's nodes would overflow the stack.
        for (const node of withBreaks(block)) {
          current.push(node);
        }
      });
  }

  endParagraph();
  return paragraphs;
}

/**
 * Text with each newline as a hard break, and each line trimmed. A newline at
 * either end still breaks, so text that ends one line and text that begins
 * the next, in different nodes, stay on their own lines.
 */
export function withBreaks(text: string): PhrasingContent[] {
  const lines = normalizeNewlines(text).split('\n');
  const nodes: PhrasingContent[] = [];

  lines.forEach((line, index) => {
    if (index > 0) {
      nodes.push({ type: 'break' });
    }

    const value = trimLine(line, index === 0, index === lines.length - 1);
    if (value) {
      nodes.push({ type: 'text', value });
    }
  });

  return nodes;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Trims a line at the ends a newline bounds. The first line's start and the
 * last line's end touch whatever comes before or after the text, so their
 * spaces stay: `a [b]bold[/b] c` keeps the spaces around `bold`.
 */
function trimLine(line: string, first: boolean, last: boolean): string {
  let value = line;
  if (!first) {
    value = value.replace(/^[ \t]+/, '');
  }
  if (!last) {
    value = value.replace(/[ \t]+$/, '');
  }
  return value;
}
