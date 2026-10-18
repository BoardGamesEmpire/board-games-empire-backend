import type { Nodes } from 'mdast';
import { parseMarkdown } from './markdown';
import { plainTextToMarkdown } from './plain-text';
import { sanitizeMarkdown } from './sanitize';

/** Every address in the Markdown a reader could follow or load, and whether any raw HTML is left. */
function reachable(markdown: string): { urls: string[]; html: boolean } {
  const urls: string[] = [];
  let html = false;

  const visit = (node: Nodes) => {
    if (node.type === 'html') {
      html = true;
    }
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      urls.push(node.url);
    }
    if ('children' in node) {
      node.children.forEach(visit);
    }
  };
  visit(parseMarkdown(markdown));

  return { urls, html };
}

describe('sanitizeMarkdown', () => {
  it('returns Markdown with nothing unsafe in it exactly as given', () => {
    const markdown = [
      '# Catan',
      '',
      '__Trade__, _build_ and ~~win~~. See [the rules](https://example.com/rules "Rules") or <https://example.com>.',
      '',
      '* [ ] task',
      '+ [mail us](mailto:hello@example.com)',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '![Box](http://example.com/box.png)',
      '',
      'A footnote[^1] and [a reference][rules].',
      '',
      '[^1]: The note.',
      '[rules]: https://example.com/rules',
    ].join('\n');

    expect(sanitizeMarkdown(markdown)).toBe(markdown);
  });

  it('strips inline raw HTML and keeps the text between its tags', () => {
    expect(sanitizeMarkdown('Hi <b onclick="x()">there</b><img src=x onerror=alert(1)>!')).toBe('Hi there!');
  });

  it('strips a block of raw HTML, script, comments and all, and a paragraph that held only HTML', () => {
    expect(sanitizeMarkdown('Before\n\n<div>\n<script>alert(1)</script>\n</div>\n\nAfter')).toBe('Before\n\nAfter');
    expect(sanitizeMarkdown('<!-- hidden -->\nShown')).toBe('Shown');
    expect(sanitizeMarkdown('Before\n\n<b></b>\n\nAfter')).toBe('Before\n\nAfter');
  });

  it('keeps the text of a block of raw HTML, with its links sanitized', () => {
    const markdown =
      'Intro\n<div align="center">\nSome **important** <a href="javascript:x">text</a>\n</div>\nMore\n\nLast';

    // The div is a block of its own, so what follows it in the HTML is too.
    expect(sanitizeMarkdown(markdown)).toBe(String.raw`Intro

Some \*\*important\*\* text

More

Last`);
  });

  it('keeps the inline content of a block of raw HTML a paragraph of its own', () => {
    expect(sanitizeMarkdown('First\n\n<span>\nSecond\n</span>\n\n<i>\nThird\n</i>')).toBe('First\n\nSecond\n\n*Third*');
    expect(sanitizeMarkdown('<span>a</span><span>b</span>\n\n<i>\n# x\n</i>')).toBe(String.raw`ab

*# x*`);
  });

  it('joins the text either side of inline HTML it removes, with no character references', () => {
    expect(sanitizeMarkdown('para\n<span>\nhello <b>w</b>\n</span>\nnext')).toBe('para\nhello w\nnext');
    expect(sanitizeMarkdown('para\n<span>')).toBe('para');
  });

  it('moves the spaces beside what it removes out of emphasis and table cells', () => {
    expect(sanitizeMarkdown('*<img src=x> a* and **b <img src=x>**')).toBe('*a* and **b**');
    expect(sanitizeMarkdown('| a |\n| - |\n| <img src=x> q |')).toBe('| a |\n| - |\n| q |');
  });

  describe('Markdown too costly to parse', () => {
    it('keeps Markdown longer than 20,000 characters as plain text', () => {
      const atLimit = '**Bold** ' + 'x'.repeat(20_000 - 9);
      const overLimit = atLimit + 'x';

      expect(sanitizeMarkdown(atLimit)).toBe(atLimit);
      expect(sanitizeMarkdown(overLimit)).toBe(plainTextToMarkdown(overLimit));
    });

    it('keeps Markdown with more than 2,000 runs of emphasis markers as plain text', () => {
      // Matching them takes time that grows with the square of their number.
      const atLimit = '~a'.repeat(2_000);
      const overLimit = atLimit + '~';

      expect(sanitizeMarkdown(atLimit)).toBe(atLimit);
      expect(sanitizeMarkdown(overLimit)).toBe(plainTextToMarkdown(overLimit));
    });

    it('counts a marker a backslash escapes as text, and one after an escaped backslash as a marker', () => {
      const escaped = String.raw`\~a`.repeat(2_001);
      const afterEscapedBackslash = String.raw`\\~a`.repeat(2_001);

      expect(sanitizeMarkdown(escaped)).toBe(escaped);
      expect(sanitizeMarkdown(afterEscapedBackslash)).toBe(plainTextToMarkdown(afterEscapedBackslash));
    });
  });

  it('drops emphasis left empty, which would otherwise read as a code fence', () => {
    expect(sanitizeMarkdown('~~<b></b>~~\n\nRest of it')).toBe('Rest of it');
    expect(sanitizeMarkdown('[<b></b>](https://example.com) and more')).toBe('and more');
  });

  it('keeps Markdown nested too deep to write out again as plain text', () => {
    const sanitized = sanitizeMarkdown('>'.repeat(5000) + ' <b>Deep</b>');
    const { children } = parseMarkdown(sanitized);

    expect(children).toEqual([
      expect.objectContaining({ type: 'paragraph', children: [expect.objectContaining({ type: 'text' })] }),
    ]);
    expect(sanitized).toContain(String.raw`\<b>Deep\</b>`);
  });

  it.each([
    ['javascript:', '[Click](javascript:alert(1))'],
    ['upper-case JAVASCRIPT:', '[Click](JAVASCRIPT:alert(1))'],
    ['an entity-encoded tab inside the scheme', '[Click](java&#x09;script:alert(1))'],
    ['a tab inside the scheme', '[Click](<java\tscript:alert(1)>)'],
    ['data:', '[Click](data:text/html,<script>alert(1)</script>)'],
    ['vbscript:', '[Click](vbscript:msgbox)'],
    ['a relative address', '[Click](/admin)'],
    ['a fragment', '[Click](#top)'],
    ['an address with no host', '[Click](https://)'],
  ])('reduces a link to %s to its text', (_, markdown) => {
    expect(sanitizeMarkdown(markdown)).toBe('Click');
  });

  it('keeps the formatting inside a link it removes', () => {
    expect(sanitizeMarkdown('[**Bold** click](javascript:alert(1))')).toBe('**Bold** click');
  });

  it('reduces an autolink to an unsafe address to its text', () => {
    const { urls, html } = reachable(sanitizeMarkdown('<javascript:alert(1)>'));

    expect(urls).toEqual([]);
    expect(html).toBe(false);
  });

  it('reduces an image with an unsafe address to its alt text, or to nothing', () => {
    expect(sanitizeMarkdown('Look: ![Box art](javascript:alert(1)) ![](data:image/png;base64,AAAA)')).toBe(
      'Look: Box art',
    );
  });

  it('reduces references to an unsafe definition to their text, and removes the definition', () => {
    const markdown = '[Click][evil] and ![Pic][evil]\n\n[evil]: javascript:alert(1)\n[evil]: https://example.com';

    expect(sanitizeMarkdown(markdown)).toBe('Click and Pic\n\n[evil]: https://example.com');
  });

  it('keeps references to a safe definition, even when a later one for the same name is unsafe', () => {
    const markdown = '[Click][site]\n\n[site]: https://example.com\n[site]: javascript:alert(1)';

    expect(sanitizeMarkdown(markdown)).toBe('[Click][site]\n\n[site]: https://example.com');
  });

  it('never leaves removed markup forming a new link', () => {
    // With the HTML gone, `[text]` and `(javascript:…)` would meet.
    const { urls } = reachable(sanitizeMarkdown('[text]<span>(javascript:alert(1))'));

    expect(urls).toEqual([]);
  });

  it.each([
    'Hi <b>there</b> [x](javascript:alert(1))',
    '[text]<span>(javascript:alert(1))',
    '<javascript:alert(1)>',
    '[a][b]\n\n[b]: javascript:x\n\n<div>\n\n[c](vbscript:y)\n\n</div>',
    '* <i>one</i>\n* [two](data:x)\n\n> <script>\n> alert(1)\n> </script>',
    '`<b>code is text</b>` and <b>this is not</b>',
  ])('leaves nothing for a second pass to remove: %j', (markdown) => {
    const once = sanitizeMarkdown(markdown);

    expect(sanitizeMarkdown(once)).toBe(once);
    expect(reachable(once).html).toBe(false);
    expect(reachable(once).urls.every((url) => /^(https?|mailto):/.test(url))).toBe(true);
  });

  it('passes a missing description through', () => {
    expect(sanitizeMarkdown(undefined)).toBeUndefined();
    expect(sanitizeMarkdown(null)).toBeNull();
  });
});
