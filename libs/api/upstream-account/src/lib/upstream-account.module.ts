import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { I18nConfigModule } from '@bge/i18n';
import { PrivacyPolicyModule } from '@bge/system-settings';
import { Module } from '@nestjs/common';
import { UpstreamAccountController } from './upstream-account.controller';
import { UpstreamAccountService } from './upstream-account.service';

/**
 * A user's upstream accounts (#935): the `users/me/upstream-accounts` routes
 * and the service a link stores its account through.
 *
 * `PrivacyPolicyModule` supplies the privacy policy a link shows (#934), and
 * `I18nConfigModule` the user's stored language it is chosen by. No import for
 * `PoliciesGuard`, `AbilityService` and `ScopeComposer`: `PermissionsModule`
 * is global.
 */
@Module({
  imports: [AuditContextModule, DatabaseModule, I18nConfigModule, PrivacyPolicyModule],
  controllers: [UpstreamAccountController],
  providers: [UpstreamAccountService],
  exports: [UpstreamAccountService],
})
export class UpstreamAccountModule {}
