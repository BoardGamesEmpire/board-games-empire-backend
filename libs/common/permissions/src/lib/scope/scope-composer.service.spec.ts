import { Action, ResourceType } from '@bge/database';
import { Unscoped } from '@bge/shared';
import type { AbilityService } from '../ability.service';
import { ScopeComposer } from './scope-composer.service';

const recordComposedScope = jest.fn();

jest.mock('@bge/shared', () => ({
  ...jest.requireActual('@bge/shared'),
  recordComposedScope: (...args: unknown[]) => recordComposedScope(...args),
}));

describe('ScopeComposer', () => {
  let abilityService: { getCurrentResourceConditions: jest.Mock };
  let composer: ScopeComposer;

  beforeEach(() => {
    recordComposedScope.mockClear();
    abilityService = { getCurrentResourceConditions: jest.fn() };
    composer = new ScopeComposer(abilityService as unknown as AbilityService);
  });

  describe('composing the two halves', () => {
    it('ANDs a permissive ceiling onto the intrinsic scope, leaving the scope intact', () => {
      // A permissive ceiling is `{}` — what an unconditioned wildcard resolves
      // to. The scope must still narrow the read; this is the case that fails
      // if conditions are treated as the answer rather than the limit.
      abilityService.getCurrentResourceConditions.mockReturnValue([{}]);

      const where = composer.compose(ResourceType.Household, Action.read, {
        members: { some: { userId: 'u1' } },
      });

      expect(where).toEqual({ members: { some: { userId: 'u1' } }, AND: [{}] });
    });

    it('ANDs a restrictive ceiling, so the caller sees the intersection and not the union', () => {
      abilityService.getCurrentResourceConditions.mockReturnValue([{ visibility: 'Public' }]);

      const where = composer.compose(ResourceType.Household, Action.read, {
        members: { some: { userId: 'u1' } },
      });

      expect(where).toEqual({
        members: { some: { userId: 'u1' } },
        AND: [{ visibility: 'Public' }],
      });
    });

    it('keeps a deny-all ceiling, so an empty page is returned rather than the whole scope', () => {
      // `AND: [{ id: { in: [] } }]` is CASL's matches-nothing clause. Dropping
      // it would turn a denial into "every row in the intrinsic scope".
      abilityService.getCurrentResourceConditions.mockReturnValue([{ id: { in: [] } }]);

      const where = composer.compose(ResourceType.Household, Action.read, {
        members: { some: { userId: 'u1' } },
      });

      expect(where).toEqual({
        members: { some: { userId: 'u1' } },
        AND: [{ id: { in: [] } }],
      });
    });

    it('concatenates an intrinsic scope that carries its own AND instead of dropping it', () => {
      abilityService.getCurrentResourceConditions.mockReturnValue([{ visibility: 'Public' }]);

      const where = composer.compose(ResourceType.Household, Action.read, {
        deletedAt: null,
        AND: [{ members: { some: { userId: 'u1' } } }],
      } as never);

      expect(where).toEqual({
        deletedAt: null,
        AND: [{ members: { some: { userId: 'u1' } } }, { visibility: 'Public' }],
      });
    });
  });

  describe('the unscoped opt-out', () => {
    it('still applies the ceiling, so an unscoped read is not an unfiltered one', () => {
      abilityService.getCurrentResourceConditions.mockReturnValue([{ visibility: 'Public' }]);

      // Deliberately NOT `Game`. A games list looks unscoped and is not: the
      // uniformity there is a missing condition, not a design (472), and this
      // is the file 418 copies its conversions from. An egress-policy list is
      // the honest shape — installation configuration with no per-caller row
      // set behind it.
      const where = composer.compose(
        ResourceType.SafeHttpPolicy,
        Action.read,
        Unscoped('egress policy is installation configuration, identical for every caller'),
      );

      expect(where).toEqual({ AND: [{ visibility: 'Public' }] });
    });

    it('refuses an opt-out with no reason', () => {
      expect(() => Unscoped('   ')).toThrow(TypeError);
    });

    it('refuses a hand-built opt-out too, rather than splicing it into the where-clause', () => {
      abilityService.getCurrentResourceConditions.mockReturnValue([{}]);

      // The sentinel is structural: this bypasses the factory's reason check.
      // Failing here rather than returning false is what keeps the mistake
      // legible — the alternative reaches Prisma as an unknown `kind` argument.
      expect(() =>
        composer.compose(ResourceType.SafeHttpPolicy, Action.read, { kind: 'unscoped', reason: '' }),
      ).toThrow(TypeError);
    });
  });

  describe('recording for the paginated() guard', () => {
    it('records the resource type of a read', () => {
      abilityService.getCurrentResourceConditions.mockReturnValue([{}]);

      composer.compose(ResourceType.Household, Action.read, { deletedAt: null });

      expect(recordComposedScope).toHaveBeenCalledWith(ResourceType.Household);
    });

    it('records an unscoped read too, since declaring no scope is still declaring one', () => {
      abilityService.getCurrentResourceConditions.mockReturnValue([{}]);

      composer.compose(ResourceType.Game, Action.read, Unscoped('install-wide catalogue'));

      expect(recordComposedScope).toHaveBeenCalledWith(ResourceType.Game);
    });

    it('does not record a write, so composing an update filter cannot vouch for a list', () => {
      abilityService.getCurrentResourceConditions.mockReturnValue([{}]);

      composer.compose(ResourceType.Household, Action.update, { id: 'h1' });

      expect(recordComposedScope).not.toHaveBeenCalled();
    });
  });

  it('asks AbilityService for the ceiling rather than resolving abilities itself', () => {
    abilityService.getCurrentResourceConditions.mockReturnValue([{}]);

    composer.compose(ResourceType.Household, Action.read, { deletedAt: null });

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.read);
  });
});
