import { PluginCategory } from '@bge/database';
import { restartProcessRoles } from './process-role';

describe('restartProcessRoles', () => {
  it('names no process role while no restart is required (#1096)', () => {
    for (const category of Object.values(PluginCategory)) {
      expect(restartProcessRoles({ category, restartRequired: false })).toEqual([]);
    }
  });

  it('names the coordinator for a data-gateway plugin that needs a restart (#1096)', () => {
    expect(restartProcessRoles({ category: PluginCategory.DataGateway, restartRequired: true })).toEqual([
      'coordinator',
    ]);
  });

  it('names the api for any other plugin that needs a restart (#1096)', () => {
    expect(restartProcessRoles({ category: PluginCategory.FeedbackSink, restartRequired: true })).toEqual(['api']);
  });

  it('returns a fresh array each call, so a caller cannot change another answer (#1096)', () => {
    const plugin = { category: PluginCategory.FeedbackSink, restartRequired: true };

    expect(restartProcessRoles(plugin)).not.toBe(restartProcessRoles(plugin));
  });
});
