import { DatabaseModule } from '@bge/database';
import { RedisModule } from '@bge/redis';
import { Global, Module } from '@nestjs/common';
import { DefaultDnsResolver } from './dns/default-dns-resolver';
import { HttpDispatcherFactory } from './http-dispatcher.factory';
import { IpPolicyService } from './ip/ip-policy.service';
import { NoopOutboundHttpObserver } from './noop-outbound-http.observer';
import { SafeHttpPolicyEventsService } from './policy/safe-http-policy-events.service';
import { SafeHttpPolicyService } from './policy/safe-http-policy.service';
import { DNS_RESOLVER, OUTBOUND_HTTP_OBSERVER } from './safe-http.tokens';
import { SecureHttpService } from './secure-http.service';

/**
 * Global registration for the safe HTTP stack. Consumers don't import
 * anything from this module — they inject `SecureHttpService` (or any of the
 * exported subordinate services) directly.
 *
 * The two extension points are bound to defaults:
 *   - `DNS_RESOLVER` → `DefaultDnsResolver` (wraps `dns.promises.lookup`).
 *   - `OUTBOUND_HTTP_OBSERVER` → `NoopOutboundHttpObserver`.
 *
 * To override either, redeclare the provider in your AppModule (or any
 * module imported by it) — NestJS's module system resolves provider
 * overrides in the importing module's scope, and the global @Module here
 * does not block local overrides.
 *
 * Depends on:
 *   - `DatabaseModule` for the `SafeHttpPolicy` singleton row.
 *   - `RedisModule` for the `CACHE_REDIS_CLIENT` used by the policy
 *     events service (pub/sub on the cache database).
 *
 * Both must be available globally by the time `SafeHttpPolicyService`'s
 * `onModuleInit` runs — they are, since both are global modules in the
 * application bootstrap.
 */
@Global()
@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [
    HttpDispatcherFactory,
    SafeHttpPolicyEventsService,
    SafeHttpPolicyService,
    IpPolicyService,
    SecureHttpService,
    { provide: DNS_RESOLVER, useClass: DefaultDnsResolver },
    { provide: OUTBOUND_HTTP_OBSERVER, useClass: NoopOutboundHttpObserver },
  ],
  exports: [
    HttpDispatcherFactory,
    SecureHttpService,
    SafeHttpPolicyService,
    SafeHttpPolicyEventsService,
    IpPolicyService,
    DNS_RESOLVER,
    OUTBOUND_HTTP_OBSERVER,
  ],
})
export class SecureHttpModule {}
