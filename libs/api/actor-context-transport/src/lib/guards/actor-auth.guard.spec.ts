import type { Actor, AuditContextService } from '@bge/actor-context';
import { t } from '@bge/i18n';
import { HttpException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AllowAnonymous,
  MemberHasPermission,
  OptionalAuth,
  OrgRoles,
  Roles,
  UserHasPermission,
} from '@thallesp/nestjs-better-auth';
import { ActorAuthGuard } from './actor-auth.guard';

// The routes carry better-auth's own decorators, not copies of their metadata
// keys, so a release that renames a key fails here instead of turning every
// public route into a 401, or leaving a role check unenforced.
class Routes {
  guarded(): void {
    // A route with no auth metadata.
  }

  @AllowAnonymous()
  anonymous(): void {
    // A route that opts out of authentication.
  }

  @OptionalAuth()
  optional(): void {
    // A route that serves with or without a caller.
  }

  @Roles(['admin'])
  roles(): void {
    // A route that asks better-auth for a role.
  }

  @OrgRoles(['owner'])
  orgRoles(): void {
    // A route that asks better-auth for an organization role.
  }

  @UserHasPermission({ permission: { user: ['ban'] } })
  userPermission(): void {
    // A route that asks better-auth for a user's permission.
  }

  @MemberHasPermission({ permissions: { project: ['create'] } })
  memberPermission(): void {
    // A route that asks better-auth for a member's permission.
  }
}

@AllowAnonymous()
class AnonymousRoutes {
  any(): void {
    // Opted out by its class.
  }
}

@Roles(['admin'])
class RoleRoutes {
  any(): void {
    // Asks for a role by its class.
  }
}

const contextFor = (target: new () => object, handler: () => void): ExecutionContext =>
  ({ getHandler: () => handler, getClass: () => target }) as unknown as ExecutionContext;

describe('ActorAuthGuard', () => {
  let actor: Actor | null;
  let guard: ActorAuthGuard;

  beforeEach(() => {
    actor = null;
    const auditContext = { getActor: () => actor } as unknown as AuditContextService;
    guard = new ActorAuthGuard(new Reflector(), auditContext);
  });

  it.each<Actor>([
    { kind: 'user', userId: 'user-1' },
    { kind: 'anonymous', userId: 'guest-1' },
    { kind: 'apiKey', apiKeyId: 'key-1', userId: 'user-1' },
  ])('admits a $kind actor', (resolved) => {
    actor = resolved;

    expect(guard.canActivate(contextFor(Routes, Routes.prototype.guarded))).toBe(true);
  });

  it("refuses a request with no actor with a 401 in better-auth's body", () => {
    let thrown: unknown;
    try {
      guard.canActivate(contextFor(Routes, Routes.prototype.guarded));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect((thrown as UnauthorizedException).getResponse()).toEqual({
      code: 'UNAUTHORIZED',
      message: t('errors.auth.unauthenticated'),
    });
  });

  it('admits a request with no actor to a route marked @AllowAnonymous()', () => {
    expect(guard.canActivate(contextFor(Routes, Routes.prototype.anonymous))).toBe(true);
  });

  it('admits a request with no actor to a route whose class is marked @AllowAnonymous()', () => {
    expect(guard.canActivate(contextFor(AnonymousRoutes, AnonymousRoutes.prototype.any))).toBe(true);
  });

  it('admits a request with no actor to a route marked @OptionalAuth()', () => {
    expect(guard.canActivate(contextFor(Routes, Routes.prototype.optional))).toBe(true);
  });

  // better-auth's guard enforced these, and this one does not, so a route
  // marked with one would otherwise serve any caller.
  describe("on a route marked with one of better-auth's authorization decorators", () => {
    beforeEach(() => {
      actor = { kind: 'user', userId: 'user-1' };
    });

    it.each([
      ['@Roles()', 'ROLES', Routes.prototype.roles],
      ['@OrgRoles()', 'ORG_ROLES', Routes.prototype.orgRoles],
      ['@UserHasPermission()', 'USER_HAS_PERMISSION', Routes.prototype.userPermission],
      ['@MemberHasPermission()', 'MEMBER_HAS_PERMISSION', Routes.prototype.memberPermission],
    ])('refuses even an authenticated caller on a route marked %s', (_decorator, key, handler) => {
      expect(() => guard.canActivate(contextFor(Routes, handler))).toThrow(new RegExp(`\\b${key}\\b.*PoliciesGuard`));
    });

    it('refuses an authenticated caller on a route whose class is marked @Roles()', () => {
      expect(() => guard.canActivate(contextFor(RoleRoutes, RoleRoutes.prototype.any))).toThrow(/\bROLES\b/);
    });

    it('answers with a server error, not a refusal the caller could fix', () => {
      let thrown: unknown;
      try {
        guard.canActivate(contextFor(Routes, Routes.prototype.roles));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(HttpException);
    });
  });
});
