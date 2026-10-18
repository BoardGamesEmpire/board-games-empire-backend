/**
 * The longest markup converted as its format. Converting HTML, BBCode or
 * Markdown takes time that grows faster than its length, and it runs inside
 * a request, an import or a search stream, so this bounds it: about 70 ms
 * for the slowest input found at this length. Longer markup is kept as plain
 * text, which converts in time in proportion to its length, about 3 µs a
 * character at worst, and shows the markup as written.
 */
const MAX_MARKUP_LENGTH = 20_000;

/**
 * The most runs of emphasis markers (`*`, `_` or `~`) Markdown is parsed
 * with. Matching them takes time that grows with the square of how many a
 * paragraph holds: 10,000 runs of `~a`, within the length bound, took half a
 * second, and 2,000 take about 25 ms. That's far more emphasis than a
 * description uses.
 */
const MAX_EMPHASIS_RUNS = 2_000;

/** A run of emphasis markers, unless a backslash escapes it, which makes it text. */
const EMPHASIS_RUN = /(?<!\\)(?:\\\\)*[*_~]+/g;

/** Whether markup is too long to convert as its format. */
export function isTooLongToConvert(markup: string): boolean {
  return markup.length > MAX_MARKUP_LENGTH;
}

/** Whether Markdown would take too long to parse, by its length or its emphasis markers. */
export function isTooCostlyToParse(markdown: string): boolean {
  if (isTooLongToConvert(markdown)) {
    return true;
  }

  const runs = new RegExp(EMPHASIS_RUN.source, EMPHASIS_RUN.flags);
  for (let count = 0; runs.exec(markdown) !== null; count++) {
    if (count >= MAX_EMPHASIS_RUNS) {
      return true;
    }
  }
  return false;
}
