import { DatabaseService } from '@bge/database';
import {
  buildPluginModuleOptions,
  MODULE_OPTIONS_TOKEN,
  PluginDirectoryResolverService,
  PluginGrantAuthorityService,
  PluginInstallerService,
} from '@bge/plugin';
import { SecureHttpService } from '@bge/secure-http';
import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PluginArtifactInstaller } from './install/plugin-artifact.installer';
import { PluginArtifactsModule } from './plugin-artifacts.module';
import { PluginArtifactReceiver } from './receive/plugin-artifact.receiver';
import { PluginArtifactStore } from './store/plugin-artifact.store';

/**
 * Stand-ins for what the api provides globally: the plugin runtime's exports
 * (configured once by its forRootAsync) and the global SecureHttpModule's
 * service. This asserts DI wiring, not behaviour.
 */
@Global()
@Module({
  providers: [
    { provide: SecureHttpService, useValue: {} },
    { provide: PluginInstallerService, useValue: {} },
    { provide: PluginDirectoryResolverService, useValue: {} },
    { provide: PluginGrantAuthorityService, useValue: {} },
    { provide: MODULE_OPTIONS_TOKEN, useValue: buildPluginModuleOptions() },
  ],
  exports: [
    SecureHttpService,
    PluginInstallerService,
    PluginDirectoryResolverService,
    PluginGrantAuthorityService,
    MODULE_OPTIONS_TOKEN,
  ],
})
class StubGlobalsModule {}

@Injectable()
class ArtifactsConsumer {
  constructor(
    readonly receiver: PluginArtifactReceiver,
    readonly installer: PluginArtifactInstaller,
    readonly store: PluginArtifactStore,
  ) {}
}

/** A module elsewhere, as the api's controller module will be, with only this module imported. */
@Module({ imports: [PluginArtifactsModule], providers: [ArtifactsConsumer] })
class ConsumerModule {}

describe('PluginArtifactsModule (#1094)', () => {
  /**
   * The module's own DatabaseModule import is kept and only its provider is
   * replaced: an override reaches only providers some imported module
   * declares, so the compile still proves the import is there. The database
   * module is not global.
   */
  const compile = (root: unknown) =>
    Test.createTestingModule({ imports: [StubGlobalsModule, root as never] })
      .overrideProvider(DatabaseService)
      .useValue({})
      .compile();

  it('builds the receiver, the installer and the store from the global runtime and its own database import (#1094)', async () => {
    const moduleRef = await compile(PluginArtifactsModule);

    expect(moduleRef.get(PluginArtifactReceiver)).toBeInstanceOf(PluginArtifactReceiver);
    expect(moduleRef.get(PluginArtifactInstaller)).toBeInstanceOf(PluginArtifactInstaller);
    expect(moduleRef.get(PluginArtifactStore)).toBeInstanceOf(PluginArtifactStore);
    await moduleRef.close();
  });

  it('exports all three to a module that imports it (#1094)', async () => {
    const moduleRef = await compile(ConsumerModule);
    const consumer = moduleRef.get(ArtifactsConsumer);

    expect(consumer.receiver).toBeInstanceOf(PluginArtifactReceiver);
    expect(consumer.installer).toBeInstanceOf(PluginArtifactInstaller);
    expect(consumer.store).toBeInstanceOf(PluginArtifactStore);
    await moduleRef.close();
  });
});
