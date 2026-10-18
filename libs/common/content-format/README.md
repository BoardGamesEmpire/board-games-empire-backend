# @bge/content-format

The server stores every game description as Markdown, and sends each game search result's summary as Markdown too: CommonMark with GitHub's extensions. A client renders it with one Markdown renderer, with raw HTML turned off (#709, #714).

- `convertToMarkdown(text, format)` converts a DataGateway's free text from the content format it declared: plain text, HTML, BBCode or Markdown. Text from a DataGateway that declared no format, or one the server doesn't know, is read as plain text. Import uses it for game and DLC descriptions, and game search for each result's summary.
- `sanitizeMarkdown(markdown)` strips raw HTML, and reduces a link or image whose address isn't http, https or mailto to its text. Converted text is sanitized the same way, and the game create and update paths run typed-in descriptions through it.

The coordinator's `FetchGame` still relays a DataGateway's game as it sent it, since import converts what it stores.

## How each format converts

- **Plain text** is escaped, so nothing in it reads as Markdown syntax. A blank line starts a paragraph, and a single newline becomes a hard break. A bare web or email address still becomes a link, as Markdown makes it however it's escaped.
- **HTML** is parsed as a browser would, then converted element by element. Scripts and styles are dropped, and elements with no Markdown equivalent leave their text. A protocol-relative address, such as `//cdn.example/box.png`, is read as https.
- **BBCode** converts `b`, `i`, `u` (as emphasis), `s`, `url`, `quote`, `code`, `list` and `*`. Any other tag is reduced to its text, and a tag counts only when it's closed. An address without a scheme, such as `[url=www.example.com]`, is read as https, and one may hold brackets in pairs. Tags nested more than 32 deep are only text, and a quote or list inside emphasis is its text on lines of its own.
- **Markdown** is only sanitized. Markdown with nothing to remove is kept exactly as sent. A block of raw HTML in it keeps its text, converted as HTML is, as a paragraph of its own.

Text that fails to convert, such as markup nested thousands deep, is read as plain text instead, so converting never fails an import or a search.

## Cost

Converting HTML, BBCode or Markdown takes time that grows faster than its length, and it runs inside a request, an import or a search stream. So markup longer than 20,000 characters, and Markdown with more than 2,000 runs of emphasis markers (`*`, `_` or `~`), are kept as plain text. At those bounds the slowest input found takes about 70 ms. Without them, 200 KB of Markdown took a minute.

Plain text has no bound. It converts in time in proportion to its length, about 3 µs a character at worst, so 0.8 s for 256 KB of one-letter lines. The serializer's own text handler searched for each node among its siblings, which made that 8 s, so `serializeMarkdown` passes it one that doesn't.

Typed-in descriptions are capped at 20,000 characters too, so the api never spends longer than that on one (`GAME_DESCRIPTION_MAX_LENGTH` in `@bge/game`). The game service holds a new or changed description to the cap, and leaves one the game already has as it is, however long.

## ESM

The parsers and serializers are the unified packages (micromark, mdast and hast), which are pure ESM. Jest transforms them through `UNIFIED_ESM_PACKAGES` in the root `jest.preset.js`. The apps `require()` them at runtime, which Node 24 supports.
