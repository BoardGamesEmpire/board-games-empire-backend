import { PLUGIN_SLUG_PATTERN, RESERVED_PLUGIN_SLUGS } from '@boardgamesempire/plugin-manifest';
import { PluginEvent } from './constants.js';

/**
 * D-K drift spec: `RESERVED_PLUGIN_SLUGS` is maintained by hand in the
 * framework-free manifest lib (the dependency points this way, so the
 * manifest lib cannot import `PluginEvent`); this spec is the enforcement
 * that keeps the two vocabularies from drifting silently — same pattern as
 * the `PluginCategory` and `PluginLifecycleEventType` bijection specs.
 */
describe('RESERVED_PLUGIN_SLUGS ↔ PluginEvent (D-K)', () => {
  const LIFECYCLE_ROUTING_PREFIX = 'plugin.';

  const derivedFromLifecycleVocabulary = new Set(
    Object.values(PluginEvent).map((routingKey) =>
      routingKey.slice(LIFECYCLE_ROUTING_PREFIX.length).replace(/_/g, '-'),
    ),
  );

  it('reserves exactly the kebab-cased lifecycle routing-key suffixes — no more, no less', () => {
    expect(new Set(RESERVED_PLUGIN_SLUGS)).toEqual(derivedFromLifecycleVocabulary);
  });

  it('every lifecycle routing key carries the plugin. prefix the derivation assumes', () => {
    for (const routingKey of Object.values(PluginEvent)) {
      expect(routingKey.startsWith(LIFECYCLE_ROUTING_PREFIX)).toBe(true);
    }
  });

  it('every reserved slug is representable as a manifest slug — the reservation is load-bearing', () => {
    for (const reservedSlug of RESERVED_PLUGIN_SLUGS) {
      expect(reservedSlug).toMatch(PLUGIN_SLUG_PATTERN);
    }
  });
});
