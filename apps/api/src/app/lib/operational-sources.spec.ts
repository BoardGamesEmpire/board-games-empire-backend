import { createSourceRule, DEFAULT_OPERATIONAL_SOURCES } from './operational-sources';

describe('the operational port source rule (#1511)', () => {
  describe('with the default list', () => {
    const allows = createSourceRule(DEFAULT_OPERATIONAL_SOURCES);

    it('lists the eight loopback, private and link-local ranges, in order', () => {
      expect(DEFAULT_OPERATIONAL_SOURCES).toEqual([
        '127.0.0.0/8',
        '::1/128',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        'fc00::/7',
        '169.254.0.0/16',
        'fe80::/10',
      ]);
    });

    it.each(['127.0.0.1', '::1', '10.1.2.3', '172.31.0.1', '192.168.1.1', 'fd00::1', '169.254.1.1', 'fe80::1'])(
      'allows %s',
      (peer) => {
        expect(allows(peer)).toBe(true);
      },
    );

    // Node reports an IPv4 peer on a dual-stack socket in this form, so it
    // has to be judged as the IPv4 address it carries.
    it.each(['::ffff:10.0.0.5', '::ffff:127.0.0.1'])('allows the IPv4-mapped %s as its IPv4 address', (peer) => {
      expect(allows(peer)).toBe(true);
    });

    it.each(['8.8.8.8', '172.32.0.1', '2001:db8::1'])('refuses %s', (peer) => {
      expect(allows(peer)).toBe(false);
    });

    it('refuses an IPv4-mapped public address, which is still a public address', () => {
      expect(allows('::ffff:8.8.8.8')).toBe(false);
    });

    // A socket that has closed has no remote address, and nothing about it is known.
    it.each([undefined, '', 'garbage'])('refuses %p, which is no address', (peer) => {
      expect(allows(peer)).toBe(false);
    });
  });

  describe('with an operator list', () => {
    const allows = createSourceRule(['203.0.113.0/24']);

    it('allows an address inside it', () => {
      expect(allows('203.0.113.9')).toBe(true);
    });

    it('replaces the defaults, so a private address outside it is refused', () => {
      expect(allows('10.0.0.1')).toBe(false);
    });
  });
});
