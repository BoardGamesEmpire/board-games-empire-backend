/** The only addresses a stored link or image may point at. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/** Whether a browser would follow the address to an allowed protocol. */
export function isSafeUrl(url: string): boolean {
  // The WHATWG parser is a browser's, so it sees `java\tscript:` and
  // ` JAVASCRIPT:` as a browser does. An address it can't parse on its own
  // is relative, and would point into whatever site shows the description.
  return URL.canParse(url) && SAFE_PROTOCOLS.has(new URL(url).protocol);
}

/**
 * A protocol-relative address, such as `//cdn.example/box.png`, as https.
 * It means "the scheme of the page it's on", and a description is shown far
 * from the page it came from.
 */
export function withScheme(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}
