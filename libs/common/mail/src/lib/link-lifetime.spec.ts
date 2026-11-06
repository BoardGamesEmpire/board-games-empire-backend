import { formatLinkLifetime } from './link-lifetime';

describe('formatLinkLifetime', () => {
  it.each([
    [1440, '24 hours'],
    [90, '1 hour, 30 minutes'],
    [15, '15 minutes'],
    [10_080, '168 hours'],
  ])('writes %i minutes as %s (#654)', (minutes, expected) => {
    expect(formatLinkLifetime(minutes, 'en')).toBe(expected);
  });
});
