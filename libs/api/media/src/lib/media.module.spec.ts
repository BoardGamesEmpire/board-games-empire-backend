import { AuditContextService } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { PoliciesGuard } from '@bge/permissions';
import { QuotaModule } from '@bge/quota';
import { ServicesModule } from '@bge/services';
import { StorageModule } from '@bge/storage';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { I18nService } from 'nestjs-i18n';
import { MediaLinkService } from './link/link.service';
import { MediaContributionNotificationListener } from './listeners/media-contribution-notification.listener';
import { MediaContributionService } from './media-contribution.service';
import { MediaModule } from './media.module';
import { MediaObjectService } from './media-object.service';

/**
 * `I18nService` is provided app-wide by nestjs-i18n's `@Global` `I18nModule`;
 * stub it globally here so it is visible to MediaModule's controller-scoped
 * filters, exactly as the real global module would be. (This test asserts DI
 * wiring, not translation.)
 */
@Global()
@Module({
  providers: [{ provide: I18nService, useValue: { translate: () => '' } }],
  exports: [I18nService],
})
class StubI18nModule {}

/**
 * Stands in for MediaModule's heavy data/service imports. Their internals are
 * not what this guards, and compiling them for real would couple this test to
 * unrelated modules' dependency graphs (Config, Redis, HTTP clients, …).
 */
@Module({})
class EmptyModule {}

/**
 * Boot-time DI guard for `MediaModule`.
 *
 * The Storage/Multer exception filters are controller-scoped (`@UseFilters`), so
 * Nest resolves their constructor deps (`I18nService` + `AuditContextService`)
 * from THIS module's injector at app startup — not per request. Drop MediaModule's
 * `AuditContextModule` import and the real api app crashes on boot; no other media
 * spec compiles the module graph, so this is the only test that catches it.
 *
 * Everything except the controller -> filter wiring is neutralised: the heavy
 * imports are emptied, the media services + `PoliciesGuard` stubbed, and Cls/I18n
 * stand in for the app-wide globals. The filters themselves are left REAL.
 */
describe('MediaModule (DI wiring smoke test)', () => {
  it('resolves its controller-scoped filter dependencies at compile time', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), StubI18nModule, MediaModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(EmptyModule)
      .overrideModule(StorageModule)
      .useModule(EmptyModule)
      .overrideModule(QuotaModule)
      .useModule(EmptyModule)
      .overrideModule(ServicesModule)
      .useModule(EmptyModule)
      .overrideModule(NotificationsServiceModule)
      .useModule(EmptyModule)
      .overrideProvider(MediaObjectService)
      .useValue({})
      .overrideProvider(MediaContributionService)
      .useValue({})
      .overrideProvider(MediaLinkService)
      .useValue({})
      .overrideProvider(MediaContributionNotificationListener)
      .useValue({})
      .overrideGuard(PoliciesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    // AuditContextService resolves only because MediaModule imports
    // AuditContextModule (the fix under guard); I18nService is global. Both are
    // exactly what the controller-scoped filters inject.
    expect(moduleRef.get(AuditContextService, { strict: false })).toBeDefined();
    await moduleRef.close();
  });
});
