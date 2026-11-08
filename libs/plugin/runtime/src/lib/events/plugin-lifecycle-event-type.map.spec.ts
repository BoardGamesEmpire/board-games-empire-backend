import { PluginLifecycleEventType } from '@bge/database';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import { PLUGIN_EVENT_TO_LIFECYCLE_TYPE } from './plugin-lifecycle-event-type.map';

describe('PLUGIN_EVENT_TO_LIFECYCLE_TYPE', () => {
  it('maps every PluginEvent routing key', () => {
    const mappedKeys = Object.keys(PLUGIN_EVENT_TO_LIFECYCLE_TYPE).sort();
    const eventValues = Object.values(PluginEvent).sort();

    expect(mappedKeys).toEqual(eventValues);
  });

  it('maps plugin.re_consent_requested to ReconsentRequested and retains no consent-suspension kinds (#1149)', () => {
    expect(PLUGIN_EVENT_TO_LIFECYCLE_TYPE[PluginEvent.ReconsentRequested]).toBe(
      PluginLifecycleEventType.ReconsentRequested,
    );
    expect(Object.keys(PluginLifecycleEventType)).not.toContain('UnitDisabled');
    expect(Object.keys(PluginLifecycleEventType)).not.toContain('UnitEnabled');
  });

  it('is a bijection onto PluginLifecycleEventType — no enum member unmapped, none reused', () => {
    const mappedValues = Object.values(PLUGIN_EVENT_TO_LIFECYCLE_TYPE);
    const enumValues = Object.values(PluginLifecycleEventType);

    expect([...mappedValues].sort()).toEqual([...enumValues].sort());
    expect(new Set(mappedValues).size).toBe(mappedValues.length);
  });
});
