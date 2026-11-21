import { AuditContextModule } from '@bge/actor-context';
import { AuthModule } from '@bge/auth';
import { DatabaseModule } from '@bge/database';
import { PrivacyPolicyModule } from '@bge/system-settings';
import { Module } from '@nestjs/common';
import { SteamLinkController } from './steam/steam-link.controller';
import { SteamLinkService } from './steam/steam-link.service';
import { SteamOpenIdVerifier } from './steam/steam-openid';
import { SteamSignInStore } from './steam/steam-sign-in.store';
import { UpstreamAccountController } from './upstream-account.controller';
import { UpstreamAccountService } from './upstream-account.service';

/**
 * A user's upstream accounts (#935): the `users/me/upstream-accounts` routes,
 * linking a Steam account through Steam sign-in, and the service a link
 * stores its account through.
 *
 * `PrivacyPolicyModule` supplies the privacy policy a link shows (#934), in the
 * user's stored language. `AuthModule` supplies the trusted-origin check a
 * link's return address passes, and the `auth.url` config the Steam sign-in's realm comes from. No import for
 * `PoliciesGuard`, `AbilityService` and `ScopeComposer`: `PermissionsModule`
 * is global, as is the cache Redis the pending sign-ins are kept in.
 *
 * The verifier's constructor takes Steam's endpoints and its timeout as plain
 * values, defaulting to Steam's own, so it is built by a factory rather than
 * injected.
 */
@Module({
  imports: [AuditContextModule, AuthModule, DatabaseModule, PrivacyPolicyModule],
  controllers: [UpstreamAccountController, SteamLinkController],
  providers: [
    UpstreamAccountService,
    SteamLinkService,
    SteamSignInStore,
    { provide: SteamOpenIdVerifier, useFactory: () => new SteamOpenIdVerifier() },
  ],
  exports: [UpstreamAccountService],
})
export class UpstreamAccountModule {}
