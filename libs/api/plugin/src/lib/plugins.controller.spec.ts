import type { PluginLifecycleService } from '@bge/plugin';
import { createMockAbilityService, MOCK_ACTING_USER_ID, type MockAbilityService } from '@bge/testing';
import { RequestMethod } from '@nestjs/common';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { PluginsController } from './plugins.controller';

const PLUGIN = { id: 'plugin-1', slug: 'demo-sink', enabled: true } as never;
const AFFECTED_UNITS = [{ scopeType: 'Household', householdId: 'hh-1' }] as never[];

describe('PluginsController (delegation)', () => {
  let controller: PluginsController;
  let lifecycle: jest.Mocked<Pick<PluginLifecycleService, 'enable' | 'disable' | 'updateConfig' | 'uninstall'>>;
  let abilityService: MockAbilityService;

  beforeEach(() => {
    lifecycle = {
      enable: jest.fn().mockResolvedValue(PLUGIN),
      disable: jest.fn().mockResolvedValue(PLUGIN),
      updateConfig: jest.fn().mockResolvedValue(PLUGIN),
      uninstall: jest.fn().mockResolvedValue({ plugin: PLUGIN, affectedUnits: AFFECTED_UNITS }),
    };
    abilityService = createMockAbilityService();
    controller = new PluginsController(lifecycle as never, abilityService as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('enable resolves the actor from CLS and forwards slug + actorId, wrapping with a success message', async () => {
    const result = await firstValueFrom(controller.enable('demo-sink'));

    expect(lifecycle.enable).toHaveBeenCalledWith({ slug: 'demo-sink', actorId: MOCK_ACTING_USER_ID });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.enabled', args: { slug: 'demo-sink' } }),
      plugin: PLUGIN,
    });
  });

  it('disable forwards slug + actorId, wrapping with a success message', async () => {
    const result = await firstValueFrom(controller.disable('demo-sink'));

    expect(lifecycle.disable).toHaveBeenCalledWith({ slug: 'demo-sink', actorId: MOCK_ACTING_USER_ID });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.disabled', args: { slug: 'demo-sink' } }),
      plugin: PLUGIN,
    });
  });

  it('updateConfig unwraps the DTO envelope — the service receives the config object itself', async () => {
    const config = { webhookUrl: 'https://example.test/hook' };

    const result = await firstValueFrom(controller.updateConfig('demo-sink', { config }));

    expect(lifecycle.updateConfig).toHaveBeenCalledWith({ slug: 'demo-sink', actorId: MOCK_ACTING_USER_ID, config });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.config_updated', args: { slug: 'demo-sink' } }),
      plugin: PLUGIN,
    });
  });

  it('uninstall forwards purgeData and surfaces the affected units beside the tombstoned row', async () => {
    const result = await firstValueFrom(controller.uninstall('demo-sink', { purgeData: true }));

    expect(lifecycle.uninstall).toHaveBeenCalledWith({
      slug: 'demo-sink',
      actorId: MOCK_ACTING_USER_ID,
      purgeData: true,
    });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.uninstalled', args: { slug: 'demo-sink' } }),
      plugin: PLUGIN,
      affectedUnits: AFFECTED_UNITS,
    });
  });

  it('an omitted purgeData stays undefined — the service owns the default', async () => {
    await firstValueFrom(controller.uninstall('demo-sink', {}));

    expect(lifecycle.uninstall).toHaveBeenCalledWith({
      slug: 'demo-sink',
      actorId: MOCK_ACTING_USER_ID,
      purgeData: undefined,
    });
  });

  describe('route registration', () => {
    // Every route lives under `:slug/<literal>`, so no parametric route can
    // shadow another and declaration order carries no constraint TODAY. The
    // paths and verbs are pinned so a future plain `:slug` or literal
    // sibling route must revisit ordering deliberately.
    it.each([
      ['enable', ':slug/enable', RequestMethod.POST],
      ['disable', ':slug/disable', RequestMethod.POST],
      ['updateConfig', ':slug/config', RequestMethod.PATCH],
      ['uninstall', ':slug/uninstall', RequestMethod.POST],
    ] as const)('binds %s to %s', (handler, path, method) => {
      expect(Reflect.getMetadata('path', PluginsController.prototype[handler])).toBe(path);
      expect(Reflect.getMetadata('method', PluginsController.prototype[handler])).toBe(method);
    });

    it('registers exactly the four lifecycle routes', () => {
      const handlers = Object.getOwnPropertyNames(PluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', PluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual(['enable', 'disable', 'updateConfig', 'uninstall']);
    });
  });
});
