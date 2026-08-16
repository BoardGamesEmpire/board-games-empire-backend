import { AuditContextService } from '@bge/actor-context';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { I18nService } from 'nestjs-i18n';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';
import { PluginsApiModule } from './plugins-api.module';

/**
 * `I18nService` is provided app-wide by nestjs-i18n's `@Global` `I18nModule`;
 * stub it globally here so it is visible to this module's controller-scoped
 * filter, exactly as the real global module would be. (This test asserts DI
 * wiring, not translation.)
 */
@Global()
@Module({
  providers: [{ provide: I18nService, useValue: { translate: () => '' } }],
  exports: [I18nService],
})
class StubI18nModule {}

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
  it('resolves the exception filter and its dependencies at compile time', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), StubI18nModule, PluginsApiModule],
    }).compile();

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

    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), StubI18nModule, ForeignHostModule],
    }).compile();

    expect(moduleRef.select(ForeignHostModule).get(PluginExceptionFilter)).toBeInstanceOf(PluginExceptionFilter);
    await moduleRef.close();
  });
});
