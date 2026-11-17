import { PluginCategory, roleLoading } from '@bge/database';
import { ConfigService } from '@nestjs/config';
import { apiPluginModuleOptions } from './plugin-module.options';

// The coordinator's spec beside its own options pins the other side: between
// them, every plugin category loads in exactly one process role (#1083).
describe("the api's plugin runtime options", () => {
  const options = apiPluginModuleOptions(new ConfigService({ plugins: { pluginsRoot: '/srv/bge/plugins' } }));

  it('leaves data-gateway plugins to the coordinator, which hosts them (#1083)', () => {
    expect(options.loadCategories).not.toContain(PluginCategory.DataGateway);
  });

  it.each(Object.values(PluginCategory))(
    'loads %s exactly when the api is the process role that loads it (#1083)',
    (category) => {
      expect(options.loadCategories.includes(category)).toBe(roleLoading(category) === 'api');
    },
  );

  it('labels its plugin load records with its own process role (#1083)', () => {
    expect(options.processRole).toBe('api');
  });

  it('reads the plugins root from its config (#1083)', () => {
    expect(options.pluginsRoot).toBe('/srv/bge/plugins');
  });
});
