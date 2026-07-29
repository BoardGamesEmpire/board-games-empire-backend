import { PluginLifecycleEventType } from '@bge/database';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import { PLUGIN_EVENT_TO_LIFECYCLE_TYPE } from './plugin-lifecycle-event-type.map';

describe('PLUGIN_EVENT_TO_LIFECYCLE_TYPE', () => {
  it('maps every PluginEvent routing key', () => {
    const mappedKeys = Object.keys(PLUGIN_EVENT_TO_LIFECYCLE_TYPE).sort();
    const eventValues = Object.values(PluginEvent).sort();

    expect(mappedKeys).toEqual(eventValues);
  });

  it('is a bijection onto PluginLifecycleEventType — no enum member unmapped, none reused', () => {
    const mappedValues = Object.values(PLUGIN_EVENT_TO_LIFECYCLE_TYPE);
    const enumValues = Object.values(PluginLifecycleEventType);

    expect([...mappedValues].sort()).toEqual([...enumValues].sort());
    expect(new Set(mappedValues).size).toBe(mappedValues.length);
  });
});
