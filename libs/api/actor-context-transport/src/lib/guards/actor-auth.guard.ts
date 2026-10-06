import { AuditContextService } from '@bge/actor-context';
import { t } from '@bge/i18n';
import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * The metadata keys `@AllowAnonymous()` and `@OptionalAuth()` from
 * `@thallesp/nestjs-better-auth` set. The package does not export them, and
 * routes keep using its decorators, so this guard reads the same strings.
 */
const ALLOW_ANONYMOUS_KEY = 'PUBLIC';
const OPTIONAL_AUTH_KEY = 'OPTIONAL';

/**
 * The keys its authorization decorators set: `@Roles()`, `@OrgRoles()`,
 * `@UserHasPermission()` and `@MemberHasPermission()`. better-auth's guard
 * enforced them and this one does not, so a route marked with one is refused,
 * rather than served to any caller as though it were checked.
 */
const UNENFORCED_KEYS = ['ROLES', 'ORG_ROLES', 'USER_HAS_PERMISSION', 'MEMBER_HAS_PERMISSION'] as const;

/**
 * Authenticates an HTTP request from the actor `HttpActorMiddleware` has
 * already resolved into CLS. Any actor passes: a session user, an anonymous
 * guest, or an API key. A request with no actor answers 401, unless its route
 * is marked `@AllowAnonymous()` or `@OptionalAuth()`. What the actor may then
 * do is `PoliciesGuard`'s question, so a route marked with one of better-auth's
 * authorization decorators answers every caller with a 500.
 *
 * It replaces better-auth's `AuthGuard` (#529), which authenticated by
 * calling `getSession`. An API key never has a session, so that guard refused
 * every request a key made, after the middleware had already accepted the
 * key. Reading the actor also checks the credential once per request: the
 * middleware's lookup is the only one.
 *
 * The 401's body is the one better-auth's guard sent, `code` included, so a
 * client matching on it still matches. Its message renders from the catalog,
 * in the request's locale, and its English is still "Unauthorized".
 *
 * Gateways never run global guards; they authenticate at the handshake.
 */
@Injectable()
export class ActorAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditContext: AuditContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const unenforced = UNENFORCED_KEYS.find((key) => this.reflector.getAllAndOverride(key, targets) !== undefined);

    // A programming error, so a 500 for every caller: the route is unusable
    // until its check moves to a policy.
    if (unenforced) {
      throw new Error(
        `This route carries better-auth's ${unenforced} metadata, which nothing enforces; check access with PoliciesGuard instead`,
      );
    }

    if (this.auditContext.getActor()) {
      return true;
    }

    const admitsNoActor =
      this.reflector.getAllAndOverride<boolean>(ALLOW_ANONYMOUS_KEY, targets) ||
      this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, targets);

    if (admitsNoActor) {
      return true;
    }

    throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: t('errors.auth.unauthenticated') });
  }
}
