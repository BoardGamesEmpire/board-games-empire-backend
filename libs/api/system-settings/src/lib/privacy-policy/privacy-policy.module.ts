import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { I18nConfigModule } from '@bge/i18n';
import { Module } from '@nestjs/common';
import { PrivacyPolicyFilesService } from './privacy-policy-files.service';
import { PrivacyPolicyController } from './privacy-policy.controller';
import { PrivacyPolicyService } from './privacy-policy.service';

/**
 * The privacy policy (#934): the policy files, read at boot, and the route
 * that serves the policy from them and the server admins' rows.
 */
@Module({
  imports: [AuditContextModule, DatabaseModule, I18nConfigModule],
  controllers: [PrivacyPolicyController],
  providers: [PrivacyPolicyService, PrivacyPolicyFilesService],
})
export class PrivacyPolicyModule {}
