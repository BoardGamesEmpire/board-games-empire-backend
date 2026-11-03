import { escapeLikePattern } from './escape-like-pattern';

describe('escapeLikePattern', () => {
  it('escapes each LIKE wildcard and the escape character itself', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('leaves text with no wildcard as it is', () => {
    expect(escapeLikePattern('Catan Night')).toBe('Catan Night');
  });
});
