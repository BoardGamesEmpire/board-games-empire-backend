import type { PhrasingContent } from 'mdast';

// Each pattern for a run of spaces starts only where the run starts, by the
// lookbehind. Without it, a long run with something other than a space after
// it is tried again from each of its spaces, in time in the square of its
// length: 2 s for 64,000.
const TRAILING_SPACE = /(?<![ \t\n])[ \t\n]*$/;
const SPACE_AROUND_NEWLINE = /(?<![ \t])[ \t]*\n[ \t\n]*/g;

/** Text without the spaces, tabs and newlines it ends with. */
export function trimEndSpace(text: string): string {
  return text.replace(TRAILING_SPACE, '');
}

/**
 * Drops what Markdown can't write: a break at either end of a paragraph, and
 * a break straight after another, since a hard break needs text after it on
 * its line. Spaces, tabs and newlines at the paragraph's two ends go too.
 * Only those: a no-break space is text to Markdown, so it stays.
 */
export function trimPhrasing(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  const kept: PhrasingContent[] = [];

  for (const node of nodes) {
    const previous = kept.at(-1);
    if (isBreakOrBlank(node) && (previous === undefined || previous.type === 'break')) {
      continue;
    }
    kept.push(node);
  }

  while (isBreakOrBlank(kept.at(-1))) {
    kept.pop();
  }

  const first = kept[0];
  if (first?.type === 'text') {
    kept[0] = { ...first, value: first.value.replace(/^[ \t\n]+/, '') };
  }
  const last = kept.at(-1);
  if (last?.type === 'text') {
    kept[kept.length - 1] = { ...last, value: trimEndSpace(last.value) };
  }

  return kept;
}

/** Drops a break straight after another, as a run of phrasing inside a paragraph can't end a line twice. */
export function collapseBreaks(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  return nodes.filter((node, index) => !(node.type === 'break' && nodes[index - 1]?.type === 'break'));
}

/**
 * Phrasing with each run of text as one node, and the spaces around a
 * newline in it as the newline alone. Text left either side of a removed tag
 * is one run to Markdown. Written as two, the newline ending the first would
 * come out as `&#xA;`, since on its own it would end the paragraph.
 */
export function joinText(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  const joined: PhrasingContent[] = [];

  for (const node of nodes) {
    const previous = joined.at(-1);
    if (node.type === 'text' && previous?.type === 'text') {
      joined[joined.length - 1] = { ...previous, value: previous.value + node.value };
    } else {
      joined.push(node);
    }
  }

  return joined.map((node) =>
    node.type === 'text' ? { ...node, value: node.value.replace(SPACE_AROUND_NEWLINE, '\n') } : node,
  );
}

/**
 * Wraps phrasing, moving the spaces and line breaks at its edges outside the
 * wrapper. Markdown can't open emphasis before a space or close it after
 * one, and `[b]Note: [/b]text` means `**Note:** text`. Nothing is left of a
 * wrapper with nothing in it.
 */
export function wrap(
  content: readonly PhrasingContent[],
  build: (inner: PhrasingContent[]) => PhrasingContent,
): PhrasingContent[] {
  const inner = [...content];
  const before: PhrasingContent[] = [];
  const after: PhrasingContent[] = [];

  while (inner.length > 0) {
    const first = inner[0];
    if (first.type === 'break') {
      before.push(first);
      inner.shift();
      continue;
    }
    if (first.type !== 'text') {
      break;
    }

    const space = leadingSpace(first.value);
    if (space) {
      before.push({ type: 'text', value: space });
    }
    if (space.length < first.value.length) {
      inner[0] = { ...first, value: first.value.slice(space.length) };
      break;
    }
    inner.shift();
  }

  while (inner.length > 0) {
    const last = inner[inner.length - 1];
    if (last.type === 'break') {
      after.unshift(last);
      inner.pop();
      continue;
    }
    if (last.type !== 'text') {
      break;
    }

    const space = trailingSpace(last.value);
    if (space) {
      after.unshift({ type: 'text', value: space });
    }
    if (space.length < last.value.length) {
      inner[inner.length - 1] = { ...last, value: last.value.slice(0, last.value.length - space.length) };
      break;
    }
    inner.pop();
  }

  return inner.length > 0 ? [...before, build(inner), ...after] : [...before, ...after];
}

function leadingSpace(text: string): string {
  return /^[ \t\n]*/.exec(text)?.[0] ?? '';
}

function trailingSpace(text: string): string {
  return TRAILING_SPACE.exec(text)?.[0] ?? '';
}

function isBreakOrBlank(node: PhrasingContent | undefined): boolean {
  return node?.type === 'break' || (node?.type === 'text' && /^[ \t\n]*$/.test(node.value));
}
