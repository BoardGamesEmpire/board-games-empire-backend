import { PluginUnitDormantReason } from '@bge/database';
import { derivePluginUnitState, PLUGIN_UNIT_STATE_CODES, type PluginUnitStateCode } from './plugin-unit-state';

describe('derivePluginUnitState (#1149)', () => {
  type Input = Parameters<typeof derivePluginUnitState>[0];

  const base: Input = { anchored: true, enabled: true, serverEnabled: true, dormantReason: null, outstandingCount: 0 };

  // Precedence, strongest first (#1149): off, unavailable,
  // needs_configuration, review_pending, on.
  it.each<[string, Input, PluginUnitStateCode]>([
    ['no unit enablement reads off even when enabled', { ...base, anchored: false, enabled: true }, 'off'],
    ['a disabled unit reads off', { ...base, enabled: false }, 'off'],
    [
      'off outranks the server switch, dormancy and outstanding consent',
      {
        anchored: true,
        enabled: false,
        serverEnabled: false,
        dormantReason: PluginUnitDormantReason.ScopeOrphaned,
        outstandingCount: 3,
      },
      'off',
    ],
    [
      'the server switch off reads unavailable for a switched-on, fully consented unit: nothing runs while it is off',
      { ...base, serverEnabled: false },
      'unavailable',
    ],
    [
      'the server switch off outranks a non-conforming configuration, which curing would not make run',
      { ...base, serverEnabled: false, dormantReason: PluginUnitDormantReason.NeedsConfiguration },
      'unavailable',
    ],
    [
      'an orphaned scope reads unavailable even with consent outstanding',
      { ...base, dormantReason: PluginUnitDormantReason.ScopeOrphaned, outstandingCount: 2 },
      'unavailable',
    ],
    [
      'a non-conforming configuration reads needs_configuration even with consent outstanding',
      { ...base, dormantReason: PluginUnitDormantReason.NeedsConfiguration, outstandingCount: 1 },
      'needs_configuration',
    ],
    ['an outstanding required permission reads review_pending', { ...base, outstandingCount: 1 }, 'review_pending'],
    ['an enabled, conforming, fully consented unit reads on', base, 'on'],
  ])('%s', (_label, input, expected) => {
    expect(derivePluginUnitState(input)).toBe(expected);
  });

  it('lists the five state codes a client can receive', () => {
    expect(PLUGIN_UNIT_STATE_CODES).toEqual(['off', 'on', 'review_pending', 'needs_configuration', 'unavailable']);
  });
});
