import { PluginCategory } from '@bge/database';
import { PLUGIN_PROCESS_ROLES, processRoleLoading, restartProcessRoles } from './process-role';

describe('process role', () => {
  it('the coordinator loads data-gateway plugins, and the api every other category (#1096)', () => {
    for (const category of Object.values(PluginCategory)) {
      expect(processRoleLoading(category)).toBe(category === PluginCategory.DataGateway ? 'coordinator' : 'api');
    }
  });

  it('only names process roles the launcher runs (#1096)', () => {
    expect(PLUGIN_PROCESS_ROLES).toEqual(['api', 'coordinator']);
  });

  it('names no process role while no restart is required', () => {
    for (const category of Object.values(PluginCategory)) {
      expect(restartProcessRoles({ category, restartRequired: false })).toEqual([]);
    }
  });

  it('names the coordinator for a data-gateway plugin that needs a restart', () => {
    expect(restartProcessRoles({ category: PluginCategory.DataGateway, restartRequired: true })).toEqual([
      'coordinator',
    ]);
  });

  it('names the api for any other plugin that needs a restart', () => {
    expect(restartProcessRoles({ category: PluginCategory.FeedbackSink, restartRequired: true })).toEqual(['api']);
  });

  it('returns a fresh array each call, so a caller cannot change another answer', () => {
    const plugin = { category: PluginCategory.FeedbackSink, restartRequired: true };

    expect(restartProcessRoles(plugin)).not.toBe(restartProcessRoles(plugin));
  });
});
