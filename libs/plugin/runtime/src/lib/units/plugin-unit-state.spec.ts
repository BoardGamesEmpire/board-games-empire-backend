import { PLUGIN_UNIT_DORMANCY_CODES } from '@bge/database';
import { derivePluginUnitState, PLUGIN_UNIT_STATE_CODES, type PluginUnitStateCode } from './plugin-unit-state';

describe('derivePluginUnitState (#1149)', () => {
  type Input = Parameters<typeof derivePluginUnitState>[0];

  const base: Input = {
    anchored: true,
    enabled: true,
    serverEnabled: true,
    dormancy: null,
    outstandingCount: 0,
  };

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
        dormancy: 'unavailable',
        outstandingCount: 3,
      },
      'off',
    ],
    [
      'a stored manifest the server cannot read arrives as dormancy unavailable: the ability refuses it, so nothing runs (#1151)',
      { ...base, dormancy: 'unavailable' },
      'unavailable',
    ],
    [
      'dormancy unavailable outranks outstanding consent (#1151)',
      { ...base, dormancy: 'unavailable', outstandingCount: 1 },
      'unavailable',
    ],
    [
      'the server switch off reads unavailable for a switched-on, fully consented unit: nothing runs while it is off',
      { ...base, serverEnabled: false },
      'unavailable',
    ],
    [
      'the server switch off outranks a non-conforming configuration, which curing would not make run',
      { ...base, serverEnabled: false, dormancy: 'needs_configuration' },
      'unavailable',
    ],
    [
      'a unit the plugin scope no longer admits reads unavailable even with consent outstanding',
      { ...base, dormancy: 'unavailable', outstandingCount: 2 },
      'unavailable',
    ],
    [
      'a non-conforming configuration reads needs_configuration even with consent outstanding',
      { ...base, dormancy: 'needs_configuration', outstandingCount: 1 },
      'needs_configuration',
    ],
    ['an outstanding required permission reads review_pending', { ...base, outstandingCount: 1 }, 'review_pending'],
    ['an enabled, conforming, fully consented unit reads on', base, 'on'],
  ])('%s', (_label, input, expected) => {
    expect(derivePluginUnitState(input)).toBe(expected);
  });

  it.each(PLUGIN_UNIT_DORMANCY_CODES)(
    'reads off for a switched-off unit whatever its dormancy (#1151): %s',
    (dormancy) => {
      expect(derivePluginUnitState({ ...base, enabled: false, dormancy })).toBe('off');
      expect(derivePluginUnitState({ ...base, anchored: false, enabled: false, dormancy })).toBe('off');
    },
  );

  it('lists the five state codes a client can receive', () => {
    expect(PLUGIN_UNIT_STATE_CODES).toEqual(['off', 'on', 'review_pending', 'needs_configuration', 'unavailable']);
  });

  it('every dormancy code is one of the state codes (#1151)', () => {
    expect(PLUGIN_UNIT_STATE_CODES).toEqual(expect.arrayContaining([...PLUGIN_UNIT_DORMANCY_CODES]));
  });
});
