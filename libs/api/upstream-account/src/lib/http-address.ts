/**
 * `address` parsed, when it is an absolute http or https address, or null when
 * it is none (#935, #1226): a return address the browser is sent back to, or
 * a profile address a client shows as a link.
 */
export function httpAddress(address: string | undefined): URL | null {
  if (address === undefined || !URL.canParse(address)) {
    return null;
  }

  const parsed = new URL(address);

  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
}
