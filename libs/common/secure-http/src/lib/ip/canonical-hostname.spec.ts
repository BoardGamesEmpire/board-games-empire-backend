import { canonicalHostname } from './canonical-hostname';

describe('canonicalHostname', () => {
  it('lower-cases a hostname (#1083)', () => {
    expect(canonicalHostname('API.Example.COM')).toBe('api.example.com');
  });

  // `example.com.` is rooted at the DNS root and names the same host.
  it('removes one trailing dot (#1083)', () => {
    expect(canonicalHostname('Example.com.')).toBe('example.com');
  });

  it('removes only one trailing dot, so a name that ends in two stays distinct (#1083)', () => {
    expect(canonicalHostname('example.com..')).toBe('example.com.');
  });

  it('leaves an IP literal as it is (#1083)', () => {
    expect(canonicalHostname('1.2.3.4')).toBe('1.2.3.4');
    expect(canonicalHostname('[::1]')).toBe('[::1]');
  });
});
