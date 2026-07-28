import {
  expandPluginPermissionSlug,
  isPluginPermissionSlug,
  parsePluginPermissionSlug,
} from './plugin-permission-slug.js';

describe('plugin permission slug envelope', () => {
  describe('expandPluginPermissionSlug', () => {
    it('wraps a bare slug in the generated envelope', () => {
      expect(expandPluginPermissionSlug('demo-sink', 'manage:digest')).toBe('plugin|demo-sink|manage:digest');
    });

    it('round-trips through parse', () => {
      const canonical = expandPluginPermissionSlug('usera-s3', 'read:storage:cloud');

      expect(parsePluginPermissionSlug(canonical)).toEqual({
        pluginSlug: 'usera-s3',
        bareSlug: 'read:storage:cloud',
        action: 'read',
        subjectPath: 'storage:cloud',
      });
    });

    it('two plugins declaring the same bare slug expand to distinct canonical forms', () => {
      expect(expandPluginPermissionSlug('usera-s3', 'read:storage:cloud')).not.toBe(
        expandPluginPermissionSlug('userb-gcp', 'read:storage:cloud'),
      );
    });

    it.each(['plugin:demo:thing', 'notaverb:thing', 'read', 'Read:thing', 'read:Thing', 'read:thing|x'])(
      "throws on non-bare input '%s' — callers hold validated values",
      (bare) => {
        expect(() => expandPluginPermissionSlug('demo-sink', bare)).toThrow(RangeError);
      },
    );

    it('throws on an invalid plugin slug', () => {
      expect(() => expandPluginPermissionSlug('Not A Slug', 'read:thing')).toThrow(RangeError);
    });
  });

  describe('parsePluginPermissionSlug', () => {
    it.each([
      'read:game', // core slug — no envelope
      'plugin|demo-sink', // missing bare segment
      'plugin|demo-sink|manage:digest|extra', // too many segments
      'plugin|Bad Slug|manage:digest', // invalid namespace segment
      'plugin|demo-sink|notaverb:thing', // bare segment without an Action verb
      'plugins|demo-sink|manage:digest', // wrong leading segment
    ])("fails loudly on malformed at-rest slug '%s'", (slug) => {
      expect(() => parsePluginPermissionSlug(slug)).toThrow(RangeError);
    });
  });

  describe('isPluginPermissionSlug', () => {
    it('discriminates the envelope from core slugs mechanically', () => {
      expect(isPluginPermissionSlug('plugin|demo-sink|manage:digest')).toBe(true);
      expect(isPluginPermissionSlug('read:game')).toBe(false);
      // the retired Phase A prefix is NOT the envelope
      expect(isPluginPermissionSlug('plugin:demo-sink:digest:manage')).toBe(false);
    });
  });
});
