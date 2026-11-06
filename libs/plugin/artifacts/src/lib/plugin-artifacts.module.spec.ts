import { AuditContextService } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import {
  buildPluginModuleOptions,
  MODULE_OPTIONS_TOKEN,
  PluginDirectoryResolverService,
  PluginGrantAuthorityService,
  PluginInstallerService,
} from '@bge/plugin';
import { SecureHttpService } from '@bge/secure-http';
import { createMockDatabaseService } from '@bge/testing';
import { buildPluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { lstat, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginArtifactInstaller } from './install/plugin-artifact.installer';
import { PluginArtifactsModule } from './plugin-artifacts.module';
import { PluginArtifactReceiver } from './receive/plugin-artifact.receiver';
import { PluginArtifactStore } from './store/plugin-artifact.store';
import { PluginArtifactSweepService } from './sweep/plugin-artifact-sweep.service';

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
   * module is not global. Nor is AuditContextModule, which the sweep's system
   * actor scope comes from; the global ClsModule behind it is the api's, as
   * here.
   */
  const compile = (root: unknown) =>
    Test.createTestingModule({ imports: [ClsModule.forRoot({ global: true }), StubGlobalsModule, root as never] })
      .overrideProvider(DatabaseService)
      .useValue({})
      .compile();

  afterEach(() => jest.restoreAllMocks());

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

  it('runs the sweep once the host starts, in its own system actor scope, and registers its interval (#1094)', async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), 'bge-sweep-module-'));
    // Nothing names it, and it was placed long ago.
    const unnamed = join(pluginsRoot, 'demo-sink', buildPluginArtifactSha256('a'));
    await mkdir(unnamed, { recursive: true });
    await utimes(unnamed, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

    const db = createMockDatabaseService();
    db.pluginArtifact.deleteMany.mockResolvedValue({ count: 0 });
    db.pluginProcessLoad.deleteMany.mockResolvedValue({ count: 0 });
    db.pluginArtifact.findMany.mockResolvedValue([]);
    // A database that has installed a plugin: the sweep spares every artifact
    // directory against one that holds no plugin row at all.
    db.plugin.findMany.mockResolvedValue([
      {
        installedSha256: buildPluginArtifactSha256('9'),
        pendingSha256: null,
        uninstalledAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    ] as never);
    db.pluginProcessLoad.findMany.mockResolvedValue([]);

    // The api registers ScheduleModule and the global ClsModule itself.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true }),
        ScheduleModule.forRoot(),
        StubGlobalsModule,
        PluginArtifactsModule,
      ],
    })
      .overrideProvider(DatabaseService)
      .useValue(db)
      .overrideProvider(MODULE_OPTIONS_TOKEN)
      .useValue(buildPluginModuleOptions({ pluginsRoot }))
      .compile();

    const audit = moduleRef.get(AuditContextService);
    const actors: unknown[] = [];
    const runs: Promise<unknown>[] = [];
    const runSweep = PluginArtifactSweepService.prototype.runSweep;
    jest.spyOn(PluginArtifactSweepService.prototype, 'runSweep').mockImplementation(function (
      this: PluginArtifactSweepService,
      now: Date,
    ) {
      actors.push(audit.getActor());
      const run = runSweep.call(this, now);
      runs.push(run);
      return run;
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    try {
      await moduleRef.init();
      await Promise.all(runs);

      expect(actors).toEqual([{ kind: 'system', reason: 'plugin-artifact-sweep' }]);
      expect(moduleRef.get(SchedulerRegistry).getIntervals()).toContain('plugin-artifact-sweep');
      // The boot run removed it.
      await expect(lstat(unnamed)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await moduleRef.close();
      await rm(pluginsRoot, { recursive: true, force: true });
    }
  });
});
