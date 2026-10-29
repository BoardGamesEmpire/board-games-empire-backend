import { PLUGIN_REQUESTED_PERMISSIONS_READER } from '@bge/database';
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from '@nestjs/common/constants.js';
import { StoredManifestRequestedPermissionsReader } from './manifest/stored-manifest-requested-permissions.reader';
import { PluginModule } from './plugin.module';

/**
 * The permissions lib injects the requested-permissions reader optionally,
 * so a missing provider never fails boot: plugin actors would quietly hold
 * nothing. This pins the wiring the api relies on instead (#577).
 */
describe('PluginModule wiring (#577)', () => {
  it('provides the requested-permissions reader globally, so the permissions lib can inject it', () => {
    expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, PluginModule)).toBe(true);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PluginModule)).toContainEqual({
      provide: PLUGIN_REQUESTED_PERMISSIONS_READER,
      useClass: StoredManifestRequestedPermissionsReader,
    });
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, PluginModule)).toContain(PLUGIN_REQUESTED_PERMISSIONS_READER);
  });
});
