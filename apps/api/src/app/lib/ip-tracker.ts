import { Logger } from '@nestjs/common';
import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';

/**
 * The bucket for a request whose socket has no address — a connection already
 * gone by the time the guard runs. One shared bucket rather than a distinct
 * empty string each time: the latter is not a limit at all.
 */
const UNKNOWN_PEER = 'unknown';

/**
 * Node joins repeated request headers with `', '` before they reach
 * `req.headers` — `set-cookie` is the only one exposed as an array — so a real
 * HTTP request always lands here as a string. The array branch is defensiveness
 * for callers that are not `IncomingMessage`, not a shape the platform produces.
 */
const forwardedChain = (header: string | string[] | undefined): string[] =>
  (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * Builds the IP tier's tracker (#340).
 *
 * THE BUG THIS REPLACES. `ThrottlerGuard.getTracker` returns `req.ip`, and
 * `main.ts` enables `trust proxy` with no hop count, so Express takes the
 * LEFTMOST `X-Forwarded-For` entry — which the client sends. A caller varying
 * that header got a fresh bucket per request, so neither the global tier nor
 * the feedback route's per-IP tier could ever trip. Unauthenticated flood
 * protection was decorative.
 *
 * Note that the obvious recipe does not fix it: `@nestjs/throttler`'s own
 * README suggests `req.ips[0]`, which is that same leftmost, client-written
 * entry. It is the first thing a search turns up, hence this paragraph.
 *
 * WHY NOT NARROW `trust proxy` INSTEAD. It also governs `req.protocol` and
 * `req.secure`, which better-auth and the cookie flags read, so changing it
 * moves more than rate limiting. Tracking is per named throttler, so the fix
 * fits entirely inside the tier that needs it and leaves the `user` tier's CLS
 * tracker alone.
 *
 * HOW `trustedHops` IS COUNTED. The chain is every `X-Forwarded-For` entry with
 * the peer address appended: the peer is the only address nobody upstream could
 * forge, and each trusted proxy in front contributes one entry to its left.
 * `trustedHops` is how many of those proxies BGE sits behind, so the client is
 * that many steps back from the end. Zero — the default — means nothing is in
 * front and the peer IS the client, which is the safe reading for a deployment
 * that has not said otherwise.
 *
 * Configuring more hops than a request actually traversed falls back to the
 * peer rather than reading further left, because further left is where the
 * client's own text begins. Buckets may merge under that fallback, which
 * over-limits rather than under-limits.
 *
 * WHAT A NON-ZERO `trustedHops` ASSUMES. That every request really did traverse
 * that many proxies — which is to say, that the app is not reachable except
 * through them. It is worth stating because the fallback above does not save
 * you here: a caller who reaches the app directly can pad `X-Forwarded-For` to
 * whatever length the hop count expects and pick their own bucket from it. The
 * right-anchored index protects against a chain that is too SHORT, not against
 * one padded to exactly the expected length. So `trustedHops` is a statement
 * about network topology, and it is only as true as the topology: bind the app
 * to the proxy's network, or leave the setting at zero.
 */
export const createIpTracker = (trustedHops: number): ThrottlerGetTrackerFunction => {
  const logger = new Logger('ThrottleTracker');
  let warnedAboutProxy = false;

  return (req: Record<string, unknown>) => {
    const socket = req['socket'] as { remoteAddress?: string } | undefined;
    const peer = socket?.remoteAddress || UNKNOWN_PEER;
    const headers = (req['headers'] ?? {}) as Record<string, string | string[] | undefined>;
    const forwarded = headers['x-forwarded-for'];

    if (trustedHops <= 0) {
      // Zero is correct when nothing is in front, and a forwarded header is the
      // only evidence available that something is. Warning at boot instead would
      // fire on every correct deployment and every local run, which teaches
      // operators to skip the one message that means something; warning per
      // request would bury it. Once, on evidence.
      if (forwarded !== undefined && !warnedAboutProxy) {
        warnedAboutProxy = true;
        logger.warn(
          'Requests carry X-Forwarded-For but THROTTLE_TRUSTED_PROXY_HOPS is 0, so rate limits key on the ' +
            'peer address. If a reverse proxy sits in front, every client currently shares one bucket per ' +
            'route and one burst refuses everyone. Set it to the number of proxies in front of this app.',
        );
      }

      return peer;
    }

    const chain = [...forwardedChain(forwarded), peer];
    const index = chain.length - 1 - trustedHops;

    return index < 0 ? peer : chain[index];
  };
};
