import { AuditContextService } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginGrantService,
  PluginInventoryService,
  PluginLifecycleService,
  PluginUnitLifecycleService,
  PluginUpdateService,
} from '@bge/plugin';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { I18nService } from 'nestjs-i18n';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';
import { PluginsApiModule } from './plugins-api.module';

/**
 * Stand-ins for the app's global modules, visible everywhere exactly as the
 * real ones are: `I18nService` (nestjs-i18n's `@Global` I18nModule),
 * `AbilityService` and `ScopeComposer` (the `@Global` PermissionsModule), and the `@Global`
 * plugin runtime's controller-injected services (configured once by the
 * host's forRootAsync). This test asserts DI wiring, not behavior — the
 * wiring under guard is still PluginsApiModule's own AuditContextModule
 * import.
 */
@Global()
@Module({
  providers: [
    { provide: I18nService, useValue: { translate: () => '' } },
    { provide: AbilityService, useValue: {} },
    { provide: ScopeComposer, useValue: {} },
    { provide: PluginLifecycleService, useValue: {} },
    { provide: PluginUpdateService, useValue: {} },
    { provide: PluginGrantService, useValue: {} },
    { provide: PluginConsentPresentationService, useValue: {} },
    { provide: PluginUnitLifecycleService, useValue: {} },
    { provide: PluginFeatureStateService, useValue: {} },
    { provide: PluginInventoryService, useValue: {} },
  ],
  exports: [
    I18nService,
    AbilityService,
    ScopeComposer,
    PluginLifecycleService,
    PluginUpdateService,
    PluginGrantService,
    PluginConsentPresentationService,
    PluginUnitLifecycleService,
    PluginFeatureStateService,
    PluginInventoryService,
  ],
})
class StubGlobalsModule {}

/**
 * Boot-time DI guard for `PluginsApiModule`.
 *
 * `PluginExceptionFilter` is controller-scoped (`@UseFilters`) on the C4
 * endpoint slices, so Nest resolves its constructor deps (`I18nService` +
 * `AuditContextService`) from THIS module's injector at app startup — not per
 * request. Drop the module's `AuditContextModule` import and the real api app
 * crashes on boot (the exact regression PR #184 fixed in media); registering
 * the filter as a provider makes that resolution eager, so this compile is
 * the test.
 */
describe('PluginsApiModule (DI wiring smoke test)', () => {
  /**
   * The module's own `DatabaseModule` import is kept and only its provider is
   * replaced, so the compile still proves the import is there: an override
   * reaches only providers some imported module declares. The household
   * liveness guard on HouseholdPluginsController needs it (#553): Nest builds a
   * controller-scoped guard in this module's injector, and the database module
   * is not global.
   */
  const compile = (root: unknown) =>
    Test.createTestingModule({ imports: [ClsModule.forRoot({ global: true }), StubGlobalsModule, root as never] })
      .overrideProvider(DatabaseService)
      .useValue({})
      .compile();

  it('resolves the exception filter and its dependencies at compile time', async () => {
    const moduleRef = await compile(PluginsApiModule);

    // The filter resolves only because PluginsApiModule imports
    // AuditContextModule (the wiring under guard); I18nService is global.
    expect(moduleRef.get(PluginExceptionFilter)).toBeInstanceOf(PluginExceptionFilter);
    expect(moduleRef.get(AuditContextService, { strict: false })).toBeDefined();
    await moduleRef.close();
  });

  it('lets a foreign host module resolve the filter by importing this module alone', async () => {
    // Nest registers a class-referenced enhancer (`@UseFilters(PluginExceptionFilter)`)
    // as an injectable of the CONTROLLER'S host module and resolves its deps
    // there. Mimic that: a foreign module providing the filter itself, with
    // PluginsApiModule as its only import. This compiles only while
    // PluginsApiModule RE-EXPORTS AuditContextModule — exporting the filter
    // alone leaves AuditContextService invisible here and the api app would
    // crash at boot when slice #320+ mounts a controller elsewhere.
    @Module({
      imports: [PluginsApiModule],
      providers: [PluginExceptionFilter],
    })
    class ForeignHostModule {}

    const moduleRef = await compile(ForeignHostModule);

    expect(moduleRef.select(ForeignHostModule).get(PluginExceptionFilter)).toBeInstanceOf(PluginExceptionFilter);
    await moduleRef.close();
  });
});
