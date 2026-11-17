import { PluginCategory, roleLoading } from '@bge/database';
import { dataGatewayProductCheck } from '@bge/gateway-plugin-host';
import { ConfigService } from '@nestjs/config';
import { coordinatorPluginModuleOptions } from './plugin-module.options';

// The api's spec beside its own options pins the other side: between them,
// every plugin category loads in exactly one process role (#1083).
describe("the coordinator's plugin runtime options", () => {
  const options = coordinatorPluginModuleOptions(new ConfigService({ plugins: { pluginsRoot: '/srv/bge/plugins' } }));

  it('loads only data-gateway plugins (#1083)', () => {
    expect(options.loadCategories).toEqual([PluginCategory.DataGateway]);
  });

  it('labels its plugin load records with the process role the gateway worker asks about (#1083)', () => {
    expect(options.processRole).toBe('coordinator');
  });

  it("checks that a data-gateway plugin's product is a driver factory (#1083)", () => {
    expect(options.productChecks).toEqual({ [PluginCategory.DataGateway]: dataGatewayProductCheck });
  });

  it.each(Object.values(PluginCategory))(
    'loads %s exactly when the coordinator is the process role that loads it (#1083)',
    (category) => {
      expect(options.loadCategories.includes(category)).toBe(roleLoading(category) === 'coordinator');
    },
  );

  it.each(Object.values(PluginCategory).filter((category) => category !== PluginCategory.DataGateway))(
    'leaves %s to the api (#1083)',
    (category) => {
      expect(roleLoading(category)).toBe('api');
    },
  );

  it("reads the plugins root from its config, which names the api's (#1083)", () => {
    expect(options.pluginsRoot).toBe('/srv/bge/plugins');
  });
});
