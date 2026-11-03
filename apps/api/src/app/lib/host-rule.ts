import { isIP, isIPv6 } from 'node:net';
import { domainToASCII } from 'node:url';

/**
 * The configuration that names the addresses this server answers at (#977).
 * Nothing is configured for this purpose alone: an address clients reach is
 * already one of these.
 */
export interface ServerNames {
  /** `auth.url`: where clients reach the api. */
  readonly publicUrl: string;
  /** `auth.trustedOrigins`, in the forms better-auth accepts. */
  readonly trustedOrigins: readonly string[];
  /** `media.baseUrl`: where the media links the api signs point. */
  readonly mediaBaseUrl: string;
}

/** Decides whether a raw `Host` header value is one this server answers to. */
export type HostRule = (hostHeader: string | undefined) => boolean;

/**
 * A `Host` value: a bracketed IPv6 address or a name, then an optional port.
 * Only these characters can reach a name pattern, so a pattern's `*` can't
 * match anything but a well-formed name.
 */
const HOST_VALUE = /^(?:\[([^\]]+)\]|([a-z0-9._-]{1,253}))(?::\d+)?$/i;

/** The schemes clients reach the api over, so the only ones that name its host. */
const WEB_SCHEMES = ['http', 'https'];

/**
 * An entry with no `://` that is a host, with at most a port or a path after it.
 * Anything else has a scheme of its own, such as `com.example.app:/callback`,
 * RFC 8252's redirect form for a native app.
 */
const HOST_WITHOUT_SCHEME = /^[^/:]*(?::(?:\d+|\{port\}|\*))?(?:\/|$)/;

const TRAILING_DOT = /\.$/;
const NON_ASCII = /\P{ASCII}/u;
const WILDCARD = /[*?]/;

/** A hostname pattern with no literal name in it, so nothing ties it to this server. */
const ONLY_WILDCARDS = /^[*?.]+$/;

/** Where an entry's authority ends. None of these is a wildcard, unlike `?`. */
const AUTHORITY_END = /[/\\#]/;

/**
 * Whether `text` matches `pattern`, where `*` is any run of characters and `?`
 * is one, as better-auth reads them. This walks both strings once and backs up
 * only to the last `*`, so its time is bounded by their lengths multiplied. A
 * regular expression of `.*`s backtracks: an entry with six `*` labels took
 * seconds against one long Host, and this runs on every request (#977).
 */
function matchesWildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let starText = 0;

  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      starAt = p++;
      starText = t;
    } else if (starAt !== -1) {
      p = starAt + 1;
      t = ++starText;
    } else {
      return false;
    }
  }

  while (pattern[p] === '*') {
    p++;
  }

  return p === pattern.length;
}

/**
 * One label of a name, in the ASCII form a browser sends as `Host`. This goes a
 * label at a time because `domainToASCII` reads a `?` as the end of the name,
 * and a label holding a wildcard has no ASCII form to convert to.
 */
function labelToAscii(label: string): string {
  return NON_ASCII.test(label) && !WILDCARD.test(label) ? domainToASCII(label) : label;
}

/**
 * The host a configured URL names, if it's a web URL. These are URLs, not
 * patterns, so a `*` or `?` in one is no wildcard, and a query or fragment can't
 * reach the host as it would by splitting on `/`.
 */
function urlHostOf(url: string): string | undefined {
  if (!URL.canParse(url)) {
    return undefined;
  }

  const { protocol, hostname } = new URL(url);

  return WEB_SCHEMES.includes(protocol.slice(0, -1)) ? hostname.replace(TRAILING_DOT, '') || undefined : undefined;
}

/**
 * The hostname pattern a TRUSTED_ORIGINS entry names, if any. Entries aren't
 * always URLs: `http://localhost:{PORT}`, `https://*.preview.example` and
 * `scrape.example` are all valid, so `new URL` can't read them. An entry whose
 * scheme covers neither web scheme, such as `myapp://` or `myapp:/callback`,
 * names no host. A wildcard scheme does cover them, as `*://bge.example` does
 * for better-auth.
 *
 * A `?` here is a wildcard, so it can't end the authority as a query would. An
 * `@` after one doesn't end user details either, since those can't hold a `?`:
 * `https://bge.example?x=@evil.example` names no host rather than `evil.example`.
 */
function hostPatternOf(entry: string): string | undefined {
  const lowered = entry.toLowerCase();
  const schemeEnd = lowered.indexOf('://');

  if (schemeEnd === -1) {
    if (!HOST_WITHOUT_SCHEME.test(lowered)) {
      return undefined;
    }
  } else {
    const scheme = lowered.slice(0, schemeEnd);
    if (!WEB_SCHEMES.some((webScheme) => matchesWildcard(scheme, webScheme))) {
      return undefined;
    }
  }

  const [authority] = (schemeEnd === -1 ? lowered : lowered.slice(schemeEnd + 3)).split(AUTHORITY_END, 1);
  const wildcardAt = authority.indexOf('?');
  const userDetails = wildcardAt === -1 ? authority : authority.slice(0, wildcardAt);
  const [hostname] = authority.slice(userDetails.lastIndexOf('@') + 1).split(':', 1);
  const labels = hostname.split('.');
  const asciiLabels = labels.map(labelToAscii);

  // `domainToASCII` answers '' for a label with no ASCII form. Dropping only
  // that label would widen the entry: `*.a‍` would become `*`.
  if (asciiLabels.some((ascii, i) => ascii === '' && labels[i] !== '')) {
    return undefined;
  }

  return asciiLabels.join('.').replace(TRAILING_DOT, '') || undefined;
}

function hostPatternsOf(names: ServerNames): string[] {
  return names.trustedOrigins.map(hostPatternOf).filter((pattern): pattern is string => pattern !== undefined);
}

/**
 * The host in a `Host` value, lower-cased and without one trailing dot, or
 * `undefined` when the value isn't a well-formed host. A bracketed value is
 * only ever an IPv6 address, so it can't reach the name patterns.
 */
function readHost(hostHeader: string): string | undefined {
  const match = HOST_VALUE.exec(hostHeader);
  if (!match) {
    return undefined;
  }

  const [, bracketed, name] = match;
  if (bracketed !== undefined) {
    return isIPv6(bracketed) ? bracketed : undefined;
  }

  return name.toLowerCase().replace(TRAILING_DOT, '') || undefined;
}

/**
 * The rule that stops DNS rebinding (#977). A page that rebinds its own domain
 * to this server's address sends its own domain as `Host`, so anything the
 * server doesn't call itself is refused.
 *
 * - An absent `Host` passes: browsers always send one, so it can't be a rebound
 *   request, and HTTP/1.0 health checkers don't. Node answers 400 to an HTTP/1.1
 *   request without one, but hands an upgrade on before that check, so a
 *   WebSocket handshake without one reaches this too. No browser sends that
 *   either.
 * - An empty `Host` is refused. Node hands `Host:` with no value, or only
 *   spaces, on as `''`, and no client that names a server sends that.
 * - An IP literal passes, because rebinding needs a hostname. The whole host
 *   must be the literal: `127.0.0.1.evil.example` is a name.
 * - `localhost` passes on any port, for development and local healthchecks.
 * - Only the hostname is compared. The port plays no part in the attack, and it
 *   differs behind a proxy.
 *
 * Callers pass the raw `Host` header. Express's `req.hostname` and `req.host`
 * prefer `X-Forwarded-Host` under `trust proxy`, and a rebound page can set that
 * header on its own `fetch`.
 */
export function createHostRule(names: ServerNames): HostRule {
  const ownHosts = new Set(
    [names.publicUrl, names.mediaBaseUrl].map(urlHostOf).filter((host): host is string => host !== undefined),
  );
  const patterns = hostPatternsOf(names);

  return (hostHeader) => {
    if (hostHeader === undefined) {
      return true;
    }

    const host = readHost(hostHeader);
    if (host === undefined) {
      return false;
    }

    return (
      isIP(host) !== 0 ||
      host === 'localhost' ||
      ownHosts.has(host) ||
      patterns.some((pattern) => matchesWildcard(pattern, host))
    );
  };
}

/**
 * Whether an entry's hostname is only wildcards, as `*`, `?*` and `*.*.*.*` are.
 * That turns the check off: a rebinding attacker picks the name, so can pick one
 * of whatever depth and shape the entry admits.
 */
export function allowsEveryHost(names: ServerNames): boolean {
  return hostPatternsOf(names).some((pattern) => ONLY_WILDCARDS.test(pattern));
}
