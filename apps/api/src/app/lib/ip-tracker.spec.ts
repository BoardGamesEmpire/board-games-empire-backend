import { Logger, type ExecutionContext } from '@nestjs/common';
import { createIpTracker } from './ip-tracker';

/**
 * #340. The property under test is one sentence: a caller cannot choose their
 * own rate-limit bucket. Every case below is a way of trying.
 */

/** A request stand-in carrying the two things the tracker reads. */
function request(options: { peer?: string; forwardedFor?: string | string[] } = {}) {
  const headers: Record<string, string | string[]> = {};
  if (options.forwardedFor !== undefined) {
    headers['x-forwarded-for'] = options.forwardedFor;
  }

  return { headers, socket: { remoteAddress: options.peer ?? '203.0.113.7' } };
}

/** The tracker never reads it; present because the signature requires one. */
const context = {} as ExecutionContext;

describe('createIpTracker', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('with no proxy in front (the default)', () => {
    const track = createIpTracker(0);

    it('keys on the peer address', async () => {
      expect(await track(request({ peer: '198.51.100.4' }), context)).toBe('198.51.100.4');
    });

    it('ignores X-Forwarded-For entirely', async () => {
      // The whole bug: before #340 this header chose the bucket, so varying it
      // per request bought a fresh budget every time and no IP tier could ever
      // trip. Nothing is in front of the app by default, so nothing here is
      // trustworthy.
      const spoofed = request({ peer: '198.51.100.4', forwardedFor: '1.2.3.4' });

      expect(await track(spoofed, context)).toBe('198.51.100.4');
    });

    it('gives a caller varying the header the same bucket every time', async () => {
      const first = await track(request({ peer: '198.51.100.4', forwardedFor: '10.0.0.1' }), context);
      const second = await track(request({ peer: '198.51.100.4', forwardedFor: '10.0.0.2' }), context);

      expect(first).toBe(second);
    });
  });

  describe('behind one proxy', () => {
    const track = createIpTracker(1);

    it('takes the address the proxy recorded, not the one the client claimed', async () => {
      // `client, proxy-saw-this` — the rightmost entry is the only one written
      // by infrastructure we control. Everything left of it the client sent.
      const req = request({ peer: '10.0.0.9', forwardedFor: '1.2.3.4, 198.51.100.4' });

      expect(await track(req, context)).toBe('198.51.100.4');
    });

    it('is unmoved by extra entries prepended by the client', async () => {
      const honest = await track(request({ peer: '10.0.0.9', forwardedFor: '198.51.100.4' }), context);
      const padded = await track(request({ peer: '10.0.0.9', forwardedFor: 'a, b, c, 198.51.100.4' }), context);

      expect(padded).toBe(honest);
    });

    it('does NOT protect a request that skipped the proxy — the hop count is a topology claim', async () => {
      // Characterisation, not an endorsement. Right-anchored indexing defends
      // against a chain shorter than the hop count, not against one padded to
      // exactly its length: a caller reaching the app directly appends their own
      // entry and the index lands on it. `trustedHops > 0` is therefore only as
      // true as "nothing reaches this app except through the proxies" — see the
      // topology paragraph on `createIpTracker`.
      const direct = request({ peer: '203.0.113.99', forwardedFor: 'i-picked-this' });

      expect(await track(direct, context)).toBe('i-picked-this');
    });
  });

  describe('behind two proxies', () => {
    const track = createIpTracker(2);

    it('steps back one hop further', async () => {
      const req = request({ peer: '10.0.0.9', forwardedFor: '1.2.3.4, 198.51.100.4, 10.0.0.8' });

      expect(await track(req, context)).toBe('198.51.100.4');
    });
  });

  describe('when the chain is shorter than the configured hop count', () => {
    const track = createIpTracker(2);

    it('falls back to the peer rather than reaching into client-supplied entries', async () => {
      // Configured for two proxies, arrived through fewer. The requested index
      // would run off the left end of the chain into territory the client
      // wrote, so the tracker stops at the one address it always knows is real.
      // Buckets may merge; none becomes spoofable.
      const req = request({ peer: '10.0.0.9', forwardedFor: '1.2.3.4' });

      expect(await track(req, context)).toBe('10.0.0.9');
    });

    it('falls back to the peer when the header is absent', async () => {
      expect(await track(request({ peer: '10.0.0.9' }), context)).toBe('10.0.0.9');
    });
  });

  describe('header shapes that are not one comma-joined string', () => {
    const track = createIpTracker(1);

    it('handles an array defensively, though Node never produces one here', async () => {
      // `IncomingMessage` joins repeated headers with ', ' before they reach
      // `req.headers`; `set-cookie` is the only one exposed as an array. So this
      // covers a non-Node caller, not a shape the platform delivers — kept
      // because the branch exists, and named so nobody reads it as evidence
      // that repeated headers arrive this way.
      const req = request({ peer: '10.0.0.9', forwardedFor: ['1.2.3.4', '198.51.100.4'] });

      expect(await track(req, context)).toBe('198.51.100.4');
    });

    it('ignores empty entries rather than counting them as hops', async () => {
      // `1.2.3.4, , 198.51.100.4` — an empty entry would otherwise shift the
      // index by one and hand the caller a hop of their choosing.
      const req = request({ peer: '10.0.0.9', forwardedFor: '1.2.3.4, , 198.51.100.4' });

      expect(await track(req, context)).toBe('198.51.100.4');
    });

    it('trims surrounding whitespace so one address is one bucket', async () => {
      const spaced = await track(request({ peer: '10.0.0.9', forwardedFor: '1.2.3.4,   198.51.100.4  ' }), context);

      expect(spaced).toBe('198.51.100.4');
    });
  });

  describe('warning when the configuration and the traffic disagree', () => {
    it('warns once when a forwarded header arrives but no hops are trusted', async () => {
      // The misconfiguration this catches is silent and expensive: behind a
      // proxy at hops 0, every client shares one bucket per route. Boot cannot
      // detect it — a forwarded header on a live request can.
      const track = createIpTracker(0);

      await track(request({ forwardedFor: '1.2.3.4' }), context);
      await track(request({ forwardedFor: '5.6.7.8' }), context);
      await track(request({ forwardedFor: '9.10.11.12' }), context);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/THROTTLE_TRUSTED_PROXY_HOPS/);
    });

    it('stays quiet on the default when nothing is forwarding', async () => {
      // Every local run and every correctly-configured direct deployment lands
      // here. A warning on the documented-correct default is how the one above
      // gets ignored.
      const track = createIpTracker(0);

      await track(request({ peer: '198.51.100.4' }), context);

      expect(warn).not.toHaveBeenCalled();
    });

    it('stays quiet when hops are configured, since the header is then expected', async () => {
      const track = createIpTracker(1);

      await track(request({ peer: '10.0.0.9', forwardedFor: '1.2.3.4, 198.51.100.4' }), context);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('when there is no peer address at all', () => {
    it('returns a constant rather than an empty bucket per request', async () => {
      // A socket can be gone by the time the guard runs. One shared bucket for
      // these is a limit; a distinct empty string per caller would be none.
      const track = createIpTracker(0);

      expect(await track({ headers: {}, socket: {} }, context)).toBe('unknown');
    });
  });
});
