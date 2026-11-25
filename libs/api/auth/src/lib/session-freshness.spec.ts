import { isSessionStale } from './session-freshness';

/** One day, in seconds, as `authFactory` sets `session.freshAge`. */
const FRESH_AGE = 86_400;
const FRESH_AGE_MS = FRESH_AGE * 1000;

const NOW = Date.parse('2026-11-23T12:00:00Z');

describe('isSessionStale (#1418)', () => {
  it('passes a session signed in less than freshAgeSeconds ago (#913, #1418)', () => {
    expect(isSessionStale({ signedInAt: new Date(NOW), now: NOW, freshAgeSeconds: FRESH_AGE })).toBe(false);
    expect(isSessionStale({ signedInAt: new Date(NOW - FRESH_AGE_MS + 1), now: NOW, freshAgeSeconds: FRESH_AGE })).toBe(
      false,
    );
  });

  // better-auth's rule: a session exactly freshAge old is already stale.
  it('finds a session signed in freshAgeSeconds ago or longer stale (#913, #1418)', () => {
    expect(isSessionStale({ signedInAt: new Date(NOW - FRESH_AGE_MS), now: NOW, freshAgeSeconds: FRESH_AGE })).toBe(
      true,
    );
    expect(isSessionStale({ signedInAt: new Date(NOW - FRESH_AGE_MS * 2), now: NOW, freshAgeSeconds: FRESH_AGE })).toBe(
      true,
    );
  });

  // better-auth's rule: a freshAge of 0 checks nothing.
  it('finds no session stale when freshAgeSeconds is 0 (#913, #1418)', () => {
    expect(isSessionStale({ signedInAt: new Date(NOW - FRESH_AGE_MS * 30), now: NOW, freshAgeSeconds: 0 })).toBe(false);
  });
});
