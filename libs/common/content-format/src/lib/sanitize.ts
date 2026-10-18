import type { Nodes, Parents, PhrasingContent, Root, RootContent } from 'mdast';
import { phrasing } from 'mdast-util-phrasing';
import { visit } from 'unist-util-visit';
import { isTooCostlyToParse } from './cost';
import { htmlTree } from './html';
import { isEmptyContainer, parseMarkdown, serializeMarkdown } from './markdown';
import { joinText, trimPhrasing, wrap } from './phrasing';
import { plainTextToMarkdown } from './plain-text';
import { isSafeUrl } from './url';

/** Parents whose children are blocks, where a block of raw HTML can stand. */
const FLOW_PARENTS: ReadonlySet<string> = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/** Parents whose children are phrasing. */
const PHRASING_PARENTS: ReadonlySet<string> = new Set([
  'delete',
  'emphasis',
  'heading',
  'link',
  'linkReference',
  'paragraph',
  'strong',
  'tableCell',
]);

/** Phrasing parents whose ends are a block's, where spaces show as nothing and are dropped. */
const TRIMMED_PARENTS: ReadonlySet<string> = new Set(['heading', 'paragraph', 'tableCell']);

/**
 * Markdown as the server stores it: raw HTML is stripped, and a link, image
 * or link definition whose address isn't http, https or mailto is reduced to
 * its text. That covers `javascript:` and `data:` addresses, and relative
 * ones too, which would point into whatever site shows the description.
 *
 * A tag inside a paragraph goes, and the text between tags stays. A block of
 * raw HTML keeps its text: it's converted as HTML is, so `<p>Hi</p>` becomes
 * `Hi`, and a script in it goes whole.
 *
 * Markdown with nothing to remove is returned exactly as given. Otherwise
 * what's left is written out again, which can change how the rest of it is
 * spelled, such as `__bold__` becoming `**bold**`, but not what it shows.
 * Markdown nested deeper than that can be written, thousands of levels, is
 * kept as plain text instead, which shows its markup as written. So is
 * Markdown that would take too long to parse: over 20,000 characters, or
 * with more than 2,000 runs of emphasis markers.
 *
 * Every description the server stores passes through here, whether a
 * DataGateway sent it or someone typed it (#714). A client should still
 * render it with raw HTML turned off.
 */
export function sanitizeMarkdown(markdown: string): string;
export function sanitizeMarkdown<T extends null | undefined>(markdown: string | T): string | T;
export function sanitizeMarkdown(markdown: string | null | undefined): string | null | undefined {
  if (markdown === null || markdown === undefined) {
    return markdown;
  }

  if (isTooCostlyToParse(markdown)) {
    return plainTextToMarkdown(markdown);
  }

  try {
    const tree = parseMarkdown(markdown);
    return sanitizeTree(tree) ? serializeMarkdown(tree) : markdown;
  } catch {
    // The tree code recurses, so a deep enough tree exhausts the stack.
    return plainTextToMarkdown(markdown);
  }
}

/** Removes everything unsafe from a Markdown tree, in place. Returns whether anything was. */
export function sanitizeTree(tree: Root): boolean {
  return clean(tree, unsafeDefinitions(tree));
}

/**
 * The identifiers that references resolve to an unsafe address. A reference
 * uses the first definition of its identifier, so a later safe one doesn't
 * rescue it.
 */
function unsafeDefinitions(tree: Nodes): Set<string> {
  const first = new Map<string, string>();
  visit(tree, 'definition', (definition) => {
    if (!first.has(definition.identifier)) {
      first.set(definition.identifier, definition.url);
    }
  });

  return new Set([...first].filter(([, url]) => !isSafeUrl(url)).map(([identifier]) => identifier));
}

/**
 * Removes everything unsafe under `parent`, in place, and any container that
 * leaves empty. Returns whether anything was. A block of raw HTML keeps its
 * text unless `htmlBlocks` is false, as it is inside such a block's own
 * conversion, where a comment comes back as raw HTML.
 */
function clean(parent: Parents, unsafeIds: ReadonlySet<string>, htmlBlocks = true): boolean {
  let changed = false;
  const kept: RootContent[] = [];

  // Nodes are kept one at a time: spread into push, a long replacement would overflow the stack.
  for (const child of parent.children) {
    const replacement = replacementFor(child, htmlBlocks && FLOW_PARENTS.has(parent.type), unsafeIds);
    if (replacement) {
      changed = true;
      for (const node of replacement) {
        kept.push(node);
      }
      continue;
    }

    if ('children' in child && clean(child, unsafeIds, htmlBlocks)) {
      changed = true;
      if (isEmptyContainer(child)) {
        continue;
      }

      if (child.type === 'emphasis' || child.type === 'strong' || child.type === 'delete') {
        // A space left at its edge goes outside it, where Markdown can write it.
        for (const node of wrap(child.children, (inner) => ({ ...child, children: inner }))) {
          kept.push(node);
        }
        continue;
      }
    }
    kept.push(child);
  }

  if (changed) {
    parent.children = tidy(parent, kept) as typeof parent.children;
  }
  return changed;
}

/**
 * A changed parent's children, ready to write out. Each parent's content
 * model is kept: what replaces a phrasing node is phrasing, and what
 * replaces a block is blocks. In phrasing, text that stood either side of
 * what went is joined, and spaces left at a paragraph's or a cell's ends are
 * dropped, which would otherwise be written out as `&#x20;`.
 */
function tidy(parent: Parents, children: RootContent[]): RootContent[] {
  if (!PHRASING_PARENTS.has(parent.type)) {
    return children;
  }

  const joined = joinText(children as PhrasingContent[]);
  return TRIMMED_PARENTS.has(parent.type) ? trimPhrasing(joined) : joined;
}

/**
 * What stands in for an unsafe node: its text, or nothing. Null for a node
 * that's safe itself, though its children may not be. Children of a link
 * that goes are cleaned before they take its place.
 */
function replacementFor(node: RootContent, htmlBlock: boolean, unsafeIds: ReadonlySet<string>): RootContent[] | null {
  switch (node.type) {
    case 'html': {
      return htmlBlock ? htmlBlockContent(node.value) : [];
    }

    case 'definition': {
      return isSafeUrl(node.url) ? null : [];
    }

    case 'link': {
      return isSafeUrl(node.url) ? null : unwrap(node, unsafeIds);
    }

    case 'linkReference': {
      return unsafeIds.has(node.identifier) ? unwrap(node, unsafeIds) : null;
    }

    case 'image': {
      return isSafeUrl(node.url) ? null : altText(node.alt);
    }

    case 'imageReference': {
      return unsafeIds.has(node.identifier) ? altText(node.alt) : null;
    }

    default: {
      return null;
    }
  }
}

/**
 * A block of raw HTML as the blocks HTML converts to, cleaned in turn. HTML
 * of only inline elements, such as a `<span>`, converts to bare phrasing,
 * which is made a paragraph so it doesn't join the one beside it.
 */
function htmlBlockContent(html: string): RootContent[] {
  const converted = htmlTree(html);
  clean(converted, new Set(), false);
  return asBlocks(converted.children);
}

/** Blocks, with each run of phrasing among them made a paragraph. */
function asBlocks(nodes: readonly RootContent[]): RootContent[] {
  const blocks: RootContent[] = [];
  let run: PhrasingContent[] = [];

  const endRun = () => {
    const children = trimPhrasing(joinText(run));
    if (children.length > 0) {
      blocks.push({ type: 'paragraph', children });
    }
    run = [];
  };

  for (const node of nodes) {
    if (phrasing(node)) {
      run.push(node);
    } else {
      endRun();
      blocks.push(node);
    }
  }

  endRun();
  return blocks;
}

function unwrap(node: Parents, unsafeIds: ReadonlySet<string>): RootContent[] {
  clean(node, unsafeIds);
  return node.children;
}

function altText(alt: string | null | undefined): PhrasingContent[] {
  return alt ? [{ type: 'text', value: alt }] : [];
}
