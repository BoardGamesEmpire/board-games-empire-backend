import { ContentFormat } from '@bge/database';
import type { Nodes } from 'mdast';
import { convertToMarkdown } from './convert';
import { parseMarkdown } from './markdown';

/**
 * What a reader sees of Markdown made only of paragraphs, text and hard
 * breaks: paragraphs apart by a blank line, a break as a newline. Throws on
 * any other node, which would mean some of the text was read as syntax.
 *
 * Bare web and email addresses are the exception, since Markdown makes them
 * links however they're escaped. They show as written, and go only to http,
 * https and mailto addresses.
 */
function shownText(markdown: string): string {
  const show = (node: Nodes): string => {
    switch (node.type) {
      case 'root': {
        return node.children.map(show).join('\n\n');
      }
      case 'paragraph': {
        return node.children.map(show).join('');
      }
      case 'link': {
        expect(node.url).toMatch(/^(https?|mailto):/);
        return node.children.map(show).join('');
      }
      case 'text': {
        return node.value;
      }
      case 'break': {
        return '\n';
      }
      default: {
        throw new Error(`Read as ${node.type}: ${JSON.stringify(markdown)}`);
      }
    }
  };

  return show(parseMarkdown(markdown));
}

describe('convertToMarkdown', () => {
  describe('plain text', () => {
    it.each([
      ['a line starting #1', '#1 pick of the year'],
      ['asterisks and underscores', 'Roll *two* dice, then __score__ them'],
      ['a numbered line', '1. Set up the board'],
      ['a dash, a quote mark and a rule', '- not a list\n> not a quote\n***'],
      ['brackets that look like a link', '[Catan](javascript:alert(1))'],
      ['raw HTML', '<script>alert(1)</script> <b>bold</b>'],
      ['an encoded entity', 'Tom &amp; Jerry &#38; friends'],
      ['backticks and a backslash', '`code` and C:\\Games\\'],
      ['a table', '| a | b |\n| - | - |\n| 1 | 2 |'],
      ['bare web and email addresses', 'See www.example.com, https://example.com or mail hello@example.com'],
    ])('shows %s as written', (_, text) => {
      const markdown = convertToMarkdown(text, ContentFormat.PlainText);

      expect(shownText(markdown)).toBe(text.replace(/[ \t]+$/gm, ''));
    });

    it('escapes an & that starts an entity, so it shows as an ampersand', () => {
      expect(convertToMarkdown('Tom &amp; Jerry', ContentFormat.PlainText)).toBe(String.raw`Tom \&amp; Jerry`);
    });

    it('starts a paragraph at a blank line and breaks the line at a single newline', () => {
      const text = 'First line\nsecond line\n\nNew paragraph';

      expect(convertToMarkdown(text, ContentFormat.PlainText)).toBe('First line\\\nsecond line\n\nNew paragraph');
    });

    it('reads Windows newlines, several blank lines and spaces at line ends as one paragraph break', () => {
      const text = '  First  \r\n \r\n\r\n\t\r\n  Second\t\r\nthird  ';

      expect(convertToMarkdown(text, ContentFormat.PlainText)).toBe('First\n\nSecond\\\nthird');
    });

    it('keeps no-break spaces, which Markdown treats as text', () => {
      const text = '  Indented ';

      expect(shownText(convertToMarkdown(text, ContentFormat.PlainText))).toBe(text);
    });

    it('converts empty or blank text to nothing', () => {
      expect(convertToMarkdown('', ContentFormat.PlainText)).toBe('');
      expect(convertToMarkdown(' \n\n \t', ContentFormat.PlainText)).toBe('');
    });

    it('reads text from a DataGateway that declared no content format as plain text', () => {
      expect(convertToMarkdown('# <b>Catan</b>', null)).toBe(
        convertToMarkdown('# <b>Catan</b>', ContentFormat.PlainText),
      );
      expect(shownText(convertToMarkdown('# <b>Catan</b>', null))).toBe('# <b>Catan</b>');
    });
  });

  describe('HTML', () => {
    it('converts paragraphs, emphasis and line breaks, and decodes entities', () => {
      const html = '<p>Catan is <b>great</b> &amp; <i>fun</i></p><p>Line one<br>Line two</p>';

      expect(convertToMarkdown(html, ContentFormat.Html)).toBe('Catan is **great** & *fun*\n\nLine one\\\nLine two');
    });

    it('converts lists, links and images', () => {
      const html =
        '<ul><li>One</li><li><a href="https://example.com">Two</a></li></ul><img src="https://example.com/box.png" alt="Box">';

      expect(convertToMarkdown(html, ContentFormat.Html)).toBe(
        '- One\n- [Two](https://example.com)\n\n![Box](https://example.com/box.png)',
      );
    });

    it('drops scripts, styles and comments, and keeps the text of elements Markdown has no equivalent for', () => {
      const html = '<script>alert(1)</script><style>p { color: red }</style><!-- note --><p><span>Kept</span></p>';

      expect(convertToMarkdown(html, ContentFormat.Html)).toBe('Kept');
    });

    it('reduces a link that is not http, https or mailto to its text', () => {
      const html =
        '<a href="javascript:alert(1)">Click</a> <a href="/games/1">Relative</a> <a href="mailto:a@b.c">Mail</a>';

      expect(convertToMarkdown(html, ContentFormat.Html)).toBe('Click Relative [Mail](mailto:a@b.c)');
    });

    it('shows escaped markup as text', () => {
      expect(shownText(convertToMarkdown('&lt;b&gt;not bold&lt;/b&gt; # *', ContentFormat.Html))).toBe(
        '<b>not bold</b> # *',
      );
    });

    it('drops elements left empty, which Markdown would read as a rule or a code fence', () => {
      expect(convertToMarkdown('<p><s></s></p><p>Rest of it</p>', ContentFormat.Html)).toBe('Rest of it');
      expect(
        convertToMarkdown('<p><b></b></p><ul><li></li></ul><a href="https://example.com"></a>', ContentFormat.Html),
      ).toBe('');
    });

    it('reads a protocol-relative address as https', () => {
      expect(
        convertToMarkdown(
          '<a href="//example.com">Site</a> <img src="//cdn.example/box.png" alt="Box">',
          ContentFormat.Html,
        ),
      ).toBe('[Site](https://example.com) ![Box](https://cdn.example/box.png)');
    });
  });

  describe('BBCode', () => {
    it('converts bold, italic, underline as emphasis, and strikethrough', () => {
      expect(convertToMarkdown('[b]bold[/b] [i]italic[/i] [u]underline[/u] [s]struck[/s]', ContentFormat.BBCode)).toBe(
        '**bold** *italic* *underline* ~~struck~~',
      );
    });

    it('is case-insensitive about tags', () => {
      expect(convertToMarkdown('[B]bold[/b] [URL=https://example.com]site[/Url]', ContentFormat.BBCode)).toBe(
        '**bold** [site](https://example.com)',
      );
    });

    it('converts a link with a label, and one that is only its address', () => {
      expect(convertToMarkdown('[url=https://example.com]Example[/url]', ContentFormat.BBCode)).toBe(
        '[Example](https://example.com)',
      );
      expect(convertToMarkdown('[url="https://example.com"]Quoted[/url]', ContentFormat.BBCode)).toBe(
        '[Quoted](https://example.com)',
      );
      expect(convertToMarkdown('[url]https://example.com[/url]', ContentFormat.BBCode)).toBe('<https://example.com>');
    });

    it('reduces a link that is not http, https or mailto to its text', () => {
      expect(convertToMarkdown('[url=javascript:alert(1)]Click[/url]', ContentFormat.BBCode)).toBe('Click');
    });

    it('converts quotes, and code as written', () => {
      expect(convertToMarkdown('[quote=Klaus]Trade wisely.[/quote]', ContentFormat.BBCode)).toBe('> Trade wisely.');
      expect(convertToMarkdown('Run [code][b]x[/b][/code] now', ContentFormat.BBCode)).toBe('Run `[b]x[/b]` now');
      expect(convertToMarkdown('[code]\nline one\n  line two\n[/code]', ContentFormat.BBCode)).toBe(
        '```\nline one\n  line two\n```',
      );
    });

    it('converts bulleted and numbered lists', () => {
      expect(convertToMarkdown('[list]\n[*]Wood\n[*]Brick[/*]\n[/list]', ContentFormat.BBCode)).toBe('- Wood\n- Brick');
      expect(convertToMarkdown('[list=1][*]Roll[*]Trade[/list]', ContentFormat.BBCode)).toBe('1. Roll\n2. Trade');
    });

    it('reduces any other tag to its text', () => {
      expect(convertToMarkdown('[color=red][size=4]Red[/size][/color] [b]bold[/b]', ContentFormat.BBCode)).toBe(
        'Red **bold**',
      );
    });

    it('leaves a tag that is never closed, or closed without opening, as written', () => {
      const bbcode = 'A [sic] note, an open [b]tag and [code]code, and a stray [/i] or [*]';

      expect(shownText(convertToMarkdown(bbcode, ContentFormat.BBCode))).toBe(bbcode);
    });

    it('closes the tag a closing tag names, leaving one opened inside it as written', () => {
      expect(convertToMarkdown('[b]bold [i]open[/b] after', ContentFormat.BBCode)).toBe(
        String.raw`**bold \[i]open** after`,
      );
    });

    it('escapes its text and keeps its line breaks, as plain text', () => {
      expect(convertToMarkdown('#1 *pick*\n[b]Tom &amp; Jerry[/b]\n\nNext', ContentFormat.BBCode)).toBe(
        String.raw`\#1 \*pick\*\
**Tom \&amp; Jerry**

Next`,
      );
    });

    it('converts nothing for empty tags, rather than a rule', () => {
      expect(convertToMarkdown('[b][/b][i] [/i]', ContentFormat.BBCode)).toBe('');
    });

    it('starts the blocks it converts on lines of their own', () => {
      expect(convertToMarkdown('Before[quote]Quoted[/quote]After', ContentFormat.BBCode)).toBe(
        'Before\n\n> Quoted\n\nAfter',
      );
    });

    it('keeps a quote or list inside emphasis as text on lines of their own', () => {
      expect(convertToMarkdown('[b][list][*]One[*]Two[/list][/b]', ContentFormat.BBCode)).toBe('**One\\\nTwo**');
      expect(convertToMarkdown('[b]Note[quote]text[/quote]more[/b]', ContentFormat.BBCode)).toBe(
        '**Note\\\ntext\\\nmore**',
      );
      expect(convertToMarkdown('[i]See[list][*]One[/list]after[/i]', ContentFormat.BBCode)).toBe(
        '*See\\\nOne\\\nafter*',
      );
    });

    it('reads a link address with brackets in it whole', () => {
      const { children } = parseMarkdown(
        convertToMarkdown('[url=https://example.com/a[1]]label[/url]', ContentFormat.BBCode),
      );

      expect(children).toEqual([
        expect.objectContaining({
          type: 'paragraph',
          children: [
            expect.objectContaining({
              type: 'link',
              url: 'https://example.com/a[1]',
              children: [expect.objectContaining({ value: 'label' })],
            }),
          ],
        }),
      ]);
    });

    it('keeps only the text of a link inside a link', () => {
      expect(
        convertToMarkdown('[url=https://a.example]A [url=https://b.example]B[/url][/url]', ContentFormat.BBCode),
      ).toBe('[A B](https://a.example)');
    });

    it.each([
      ['[b]Note: [/b]text', '**Note:** text'],
      ['a[i] b[/i]', 'a *b*'],
      ['one[b] two [/b]three', 'one **two** three'],
      ['see[url=https://example.com] here [/url]now', 'see [here](https://example.com) now'],
      ['[b]line\n[/b]next', '**line**\\\nnext'],
    ])('keeps the spaces and breaks at a tag’s edges outside it: %j', (bbcode, markdown) => {
      expect(convertToMarkdown(bbcode, ContentFormat.BBCode)).toBe(markdown);
    });

    it('leaves the items of a list that is never closed as written', () => {
      const bbcode = '[list][*]Wood[*]Brick';

      expect(shownText(convertToMarkdown(bbcode, ContentFormat.BBCode))).toBe(bbcode);
    });

    it('reads a link address without a scheme as https', () => {
      expect(
        convertToMarkdown('[url=www.example.com]Site[/url] [url=//cdn.example]CDN[/url]', ContentFormat.BBCode),
      ).toBe('[Site](https://www.example.com) [CDN](https://cdn.example)');
    });

    it('reads tags nested deeper than 32 as text', () => {
      const bbcode = '[i]'.repeat(40) + 'x' + '[/i]'.repeat(40);

      expect(convertToMarkdown(bbcode, ContentFormat.BBCode)).toContain(String.raw`\[i]`);
    });
  });

  describe('Markdown', () => {
    it('keeps safe Markdown exactly as sent', () => {
      const markdown = '__Bold__ and [a link](https://example.com)\n\n* one\n* two';

      expect(convertToMarkdown(markdown, ContentFormat.Markdown)).toBe(markdown);
    });

    it('sanitizes it', () => {
      expect(convertToMarkdown('Hi <b>there</b> [x](javascript:alert(1))', ContentFormat.Markdown)).toBe('Hi there x');
    });

    it('keeps the text of a block of raw HTML, converted as HTML is', () => {
      expect(convertToMarkdown('<p>Catan is a <b>game</b></p>', ContentFormat.Markdown)).toBe('Catan is a **game**');
    });
  });

  describe('markup nested too deep to convert', () => {
    // Within 20,000 characters, so it's the nesting that fails, not the length
    // that's kept as plain text. BBCode can't nest this deep.
    it.each([
      ['HTML', ContentFormat.Html, '<i>'.repeat(6_600) + 'Deep'],
      ['Markdown with something to remove', ContentFormat.Markdown, '>'.repeat(5000) + ' <b>Deep</b>'],
    ])('reads %s as plain text rather than failing', (_, format, text) => {
      const markdown = convertToMarkdown(text, format);

      expect(markdown).toContain('Deep');
    });
  });

  describe('markup too long to convert', () => {
    it.each([
      ['HTML', ContentFormat.Html, '<b>Bold</b> '],
      ['BBCode', ContentFormat.BBCode, '[b]Bold[/b] '],
      ['Markdown', ContentFormat.Markdown, '**Bold** '],
    ])('reads %s longer than 20,000 characters as plain text', (_, format, markup) => {
      const atLimit = markup + 'x'.repeat(20_000 - markup.length);
      const overLimit = atLimit + 'x';

      expect(convertToMarkdown(atLimit, format)).toMatch(/^\*\*Bold\*\* x/);
      expect(shownText(convertToMarkdown(overLimit, format))).toBe(overLimit);
    });

    it('converts plain text of any length, in time in proportion to it', () => {
      // Writing a paragraph out took time in the square of its lines: 8 s for
      // 128,000. In proportion, it's well under a second.
      const text = 'line\n'.repeat(120_000);
      const started = performance.now();

      expect(convertToMarkdown(text, null)).toBe(Array.from({ length: 120_000 }, () => 'line').join('\\\n'));
      expect(performance.now() - started).toBeLessThan(3_000);
    });
  });

  it('passes a missing text through', () => {
    expect(convertToMarkdown(undefined, ContentFormat.Html)).toBeUndefined();
    expect(convertToMarkdown(null, ContentFormat.Html)).toBeNull();
  });
});
