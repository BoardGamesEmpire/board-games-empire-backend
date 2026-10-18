import type { BlockContent, PhrasingContent, Root } from 'mdast';
import { collapseBreaks, wrap } from './phrasing';
import { toParagraphs, withBreaks } from './plain-text';
import { withScheme } from './url';

/**
 * An opening or closing tag: `[b]`, `[/b]`, `[url=https://…]`, `[*]`. An
 * attribute may hold brackets in pairs, as an address can:
 * `[url=https://example.com/a[1]]`.
 */
const TAG = /\[(\/?)(\*|[a-z][a-z0-9]*)(?:=((?:[^[\]\n]|\[[^[\]\n]*\])*))?\]/gi;

/** The tags converted to Markdown. Any other tag is reduced to its text. */
const KNOWN_TAGS: ReadonlySet<string> = new Set(['b', 'i', 'u', 's', 'url', 'quote', 'code', 'list']);

/**
 * How deep tags may nest. An opening tag deeper than this is only text, so no
 * input costs more than this much nesting to convert. Real BBCode rarely
 * nests more than a few deep.
 */
const MAX_NESTING = 32;

interface BbElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attribute: string | undefined;
  readonly children: BbNode[];
}

interface BbText {
  readonly kind: 'text';
  value: string;
}

/** `[*]`, which starts a list item, as written, for a list that's never closed. */
interface BbItem {
  readonly kind: 'item';
  readonly tag: string;
}

type BbNode = BbElement | BbText | BbItem;

/** An element still open while parsing, with the tag that opened it. */
interface OpenElement extends BbElement {
  readonly openingTag: string;
}

/**
 * BBCode as a Markdown tree. Bold, italic, underline (as emphasis, since
 * Markdown has no underline), strikethrough, links, quotes, code and lists
 * convert to their Markdown equivalents; any other tag, such as
 * `[color=red]`, is reduced to its text. A tag counts only when it's closed,
 * so an unclosed `[b]` or a bracketed `[sic]` stays as written. Text is
 * escaped and its line breaks kept, as plain text's are.
 */
export function bbcodeTree(bbcode: string): Root {
  return { type: 'root', children: toFlow(parse(bbcode.replace(/\r\n?/g, '\n'))) };
}

function parse(source: string): BbNode[] {
  const root: OpenElement = { kind: 'element', name: '', attribute: undefined, children: [], openingTag: '' };
  const stack: OpenElement[] = [root];
  const top = () => stack[stack.length - 1];

  // Where a search for `[/code]` last found none. None follows any later
  // point either, so an unclosed `[code]` doesn't search the rest again.
  let noCodeCloseFrom = source.length;

  let index = 0;
  const tags = new RegExp(TAG.source, TAG.flags);

  for (let match = tags.exec(source); match !== null; match = tags.exec(source)) {
    append(top(), { kind: 'text', value: source.slice(index, match.index) });
    index = tags.lastIndex;

    const [tag, closing, rawName, rawAttribute] = match;
    const name = rawName.toLowerCase();
    const attribute = rawAttribute?.trim().replace(/^(["'])(.*)\1$/, '$2');

    if (name === '*') {
      // Only a list's own items count. An item ends where the next starts,
      // so `[/*]` needs nothing doing.
      if (top().name !== 'list') {
        append(top(), { kind: 'text', value: tag });
      } else if (!closing) {
        append(top(), { kind: 'item', tag });
      }
      continue;
    }

    if (!closing && name === 'code') {
      // Code is shown as written, tags and all, up to its closing tag.
      const close = new RegExp(String.raw`\[/code\]`, 'gi');
      close.lastIndex = index;
      const end = index < noCodeCloseFrom ? close.exec(source) : null;

      if (end === null) {
        noCodeCloseFrom = Math.min(noCodeCloseFrom, index);
        append(top(), { kind: 'text', value: tag });
      } else {
        const code = source.slice(index, end.index);
        append(top(), { kind: 'element', name, attribute, children: [{ kind: 'text', value: code }] });
        index = tags.lastIndex = close.lastIndex;
      }
      continue;
    }

    if (!closing) {
      if (stack.length > MAX_NESTING) {
        append(top(), { kind: 'text', value: tag });
      } else {
        stack.push({ kind: 'element', name, attribute, children: [], openingTag: tag });
      }
      continue;
    }

    const depth = openDepth(stack, name);
    if (depth < 0) {
      append(top(), { kind: 'text', value: tag });
      continue;
    }

    while (stack.length - 1 > depth) {
      leaveUnclosed(stack);
    }

    const element = stack.pop() as OpenElement;
    const parent = top();
    if (KNOWN_TAGS.has(name)) {
      append(parent, { kind: 'element', name, attribute: element.attribute, children: element.children });
    } else {
      element.children.forEach((child) => append(parent, child));
    }
  }

  append(top(), { kind: 'text', value: source.slice(index) });
  while (stack.length > 1) {
    leaveUnclosed(stack);
  }

  return root.children;
}

/** How deep in the stack the innermost open `name` is, or -1 when none is open. */
function openDepth(stack: readonly OpenElement[], name: string): number {
  for (let depth = stack.length - 1; depth > 0; depth--) {
    if (stack[depth].name === name) {
      return depth;
    }
  }
  return -1;
}

/** Pops an element that was never closed: its opening tag, and a list's items, are only text. */
function leaveUnclosed(stack: OpenElement[]): void {
  const element = stack.pop() as OpenElement;
  const parent = stack[stack.length - 1];

  append(parent, { kind: 'text', value: element.openingTag });
  for (const child of element.children) {
    append(parent, child.kind === 'item' ? { kind: 'text', value: child.tag } : child);
  }
}

/** Adds a node, joining it to text just before it, so a blank line split across the two is still seen. */
function append(parent: BbElement, node: BbNode): void {
  const last = parent.children.at(-1);

  if (node.kind !== 'text') {
    parent.children.push(node);
  } else if (last?.kind === 'text') {
    last.value += node.value;
  } else if (node.value) {
    parent.children.push({ ...node });
  }
}

/** Nodes as blocks: quotes, lists and multi-line code stand alone, and the text between them forms paragraphs. */
function toFlow(nodes: readonly BbNode[]): BlockContent[] {
  const blocks: BlockContent[] = [];
  let inline: PhrasingContent[] = [];

  // Nodes are added one at a time: spread into push, a long text's would overflow the stack.
  const endInline = () => {
    for (const paragraph of toParagraphs(inline)) {
      blocks.push(paragraph);
    }
    inline = [];
  };

  for (const node of nodes) {
    const block = toBlock(node);
    if (block) {
      endInline();
      for (const converted of block) {
        blocks.push(converted);
      }
    } else if (node.kind === 'text') {
      // Its newlines split paragraphs, so they're left for toParagraphs.
      inline.push({ type: 'text', value: node.value });
    } else {
      for (const phrasing of toPhrasing(node, false)) {
        inline.push(phrasing);
      }
    }
  }

  endInline();
  return blocks;
}

/**
 * The blocks a node stands for, or undefined for one that sits inside a
 * paragraph. Whatever turns out empty, such as a list with no items, is
 * dropped when the tree is written out.
 */
function toBlock(node: BbNode): BlockContent[] | undefined {
  if (node.kind !== 'element') {
    return undefined;
  }

  switch (node.name) {
    case 'quote': {
      return [{ type: 'blockquote', children: toFlow(node.children) }];
    }

    case 'list': {
      const [lead, ...items] = splitItems(node.children);

      // `[list=1]` numbers its items. Markdown can't letter them, so `[list=a]` numbers them too.
      return [
        ...toFlow(lead),
        {
          type: 'list',
          ordered: Boolean(node.attribute),
          spread: false,
          children: items.map((item) => ({ type: 'listItem', spread: false, children: toFlow(item) })),
        },
      ];
    }

    case 'code': {
      const code = codeOf(node);
      return code.includes('\n') ? [{ type: 'code', value: code }] : undefined;
    }

    default: {
      return undefined;
    }
  }
}

/**
 * A node inside a paragraph. Inside a link, another link is only its text,
 * since Markdown can't nest them. A quote or list here, inside emphasis say,
 * is reduced to its text on lines of its own, and its items on theirs.
 */
function toPhrasing(node: BbNode, inLink: boolean): PhrasingContent[] {
  if (node.kind === 'text') {
    return withBreaks(node.value);
  }

  if (node.kind === 'item') {
    return [{ type: 'break' }];
  }

  const children = (linked: boolean) => collapseBreaks(node.children.flatMap((child) => toPhrasing(child, linked)));

  switch (node.name) {
    case 'b': {
      return wrap(children(inLink), (content) => ({ type: 'strong', children: content }));
    }

    case 'i':
    case 'u': {
      return wrap(children(inLink), (content) => ({ type: 'emphasis', children: content }));
    }

    case 's': {
      return wrap(children(inLink), (content) => ({ type: 'delete', children: content }));
    }

    case 'code': {
      const code = codeOf(node).replace(/\n/g, ' ');
      return code ? [{ type: 'inlineCode', value: code }] : [];
    }

    case 'url': {
      if (inLink) {
        return children(true);
      }

      const url = linkAddress(node.attribute ?? textOf(node));
      const label = children(true);
      return wrap(label.length > 0 ? label : [{ type: 'text', value: url }], (content) => ({
        type: 'link',
        url,
        children: content,
      }));
    }

    default: {
      // quote and list
      return [{ type: 'break' }, ...children(inLink), { type: 'break' }];
    }
  }
}

/**
 * A `[url]`'s address. BBCode often leaves off the scheme, as in
 * `[url=www.example.com]`, which means the web address.
 */
function linkAddress(address: string): string {
  const trimmed = address.trim();
  return /^www\./i.test(trimmed) ? `https://${trimmed}` : withScheme(trimmed);
}

/** A list's children split at each `[*]`: what comes before the first item, then each item. */
function splitItems(children: readonly BbNode[]): BbNode[][] {
  const segments: BbNode[][] = [[]];
  for (const child of children) {
    if (child.kind === 'item') {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(child);
    }
  }
  return segments;
}

/** A code element's text, without the newline that usually follows `[code]` or precedes `[/code]`. */
function codeOf(node: BbElement): string {
  return textOf(node).replace(/^\n/, '').replace(/\n$/, '');
}

function textOf(node: BbNode): string {
  if (node.kind === 'text') {
    return node.value;
  }
  return node.kind === 'element' ? node.children.map(textOf).join('') : '';
}
