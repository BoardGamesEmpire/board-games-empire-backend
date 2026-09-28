import { t } from '@bge/i18n';
import { ForbiddenException } from '@nestjs/common';
import type { AbilityService } from '../ability.service';
import { resolveActingUserIdOrNull, resolveScopeSubjectId } from './resolve-scope-subject-id';

describe('the acting-user resolvers', () => {
  let abilityService: { getActingUserId: jest.Mock };
  const resolve = () => abilityService as unknown as AbilityService;

  beforeEach(() => {
    abilityService = { getActingUserId: jest.fn() };
  });

  // What `getActingUserId` throws for a plugin, system or external actor.
  const userless = () => {
    abilityService.getActingUserId.mockImplementation(() => {
      throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
    });
  };

  // Nothing primed the context: a programmer error, not an actor kind.
  const unprimed = new Error('no actor in context');
  const missing = () => {
    abilityService.getActingUserId.mockImplementation(() => {
      throw unprimed;
    });
  };

  describe('resolveActingUserIdOrNull', () => {
    it('answers the acting user', () => {
      abilityService.getActingUserId.mockReturnValue('user-1');

      expect(resolveActingUserIdOrNull(resolve())).toBe('user-1');
    });

    it('answers null for an actor with no user behind it', () => {
      userless();

      expect(resolveActingUserIdOrNull(resolve())).toBeNull();
    });

    it('lets a missing actor through as the failure it is', () => {
      missing();

      expect(() => resolveActingUserIdOrNull(resolve())).toThrow(unprimed);
    });
  });

  describe('resolveScopeSubjectId', () => {
    it('answers the acting user', () => {
      abilityService.getActingUserId.mockReturnValue('user-1');

      expect(resolveScopeSubjectId(resolve())).toBe('user-1');
    });

    it('refuses an actor with no user behind it, in terms of access rather than writes', () => {
      userless();

      const rejection: unknown = (() => {
        try {
          return resolveScopeSubjectId(resolve());
        } catch (error) {
          return error;
        }
      })();

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
    });

    it('lets a missing actor through as the failure it is', () => {
      missing();

      expect(() => resolveScopeSubjectId(resolve())).toThrow(unprimed);
    });
  });
});
