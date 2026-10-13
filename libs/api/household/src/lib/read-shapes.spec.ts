import { Prisma } from '@bge/database';
import { CONTEXT_INVITE_SELECT } from '@bge/invites';
import { MEMBER_SCALARS_OMITTED, MEMBER_SELECT } from './read-shapes';

/**
 * The scalar keys of a select object: the ones written `field: true`, as
 * opposed to the relation keys, which carry a nested `select`.
 *
 * Reading the shape rather than being handed a list is the point — a scalar
 * added to the select is counted here whether or not anyone updated a fixture.
 */
const scalarKeysOf = (select: Record<string, unknown>): string[] =>
  Object.entries(select)
    .filter(([, value]) => value === true)
    .map(([key]) => key);

/**
 * `#297` / `D-297-5`. Prisma's `include:` returns every scalar on the model,
 * and the household routes have no `ClassSerializerInterceptor` — so a column
 * added to a model reached clients without anyone choosing to publish it. That
 * is how membership provenance (#296) and `Invite.token` (#297) became public.
 *
 * These specs are the guard that stops it recurring. They read the model's
 * scalars out of the GENERATED client rather than a hand-written list, so
 * adding a column to `prisma/models` fails them until someone classifies it as
 * published or deliberately withheld. A fixture-based test would pass instead,
 * which is exactly the failure being fixed.
 *
 * The invite shapes are guarded the same way in `@bge/invites` (#161).
 */
describe('household read shapes', () => {
  describe('MEMBER_SELECT', () => {
    it('classifies every HouseholdMember scalar as either selected or deliberately omitted', () => {
      const declared = Object.values(Prisma.HouseholdMemberScalarFieldEnum).sort();
      const classified = [...scalarKeysOf(MEMBER_SELECT), ...Object.keys(MEMBER_SCALARS_OMITTED)].sort();

      // A new column lands here first. Publish it by adding it to
      // MEMBER_SELECT, or withhold it by adding it to MEMBER_SCALARS_OMITTED
      // with the reason — but decide, rather than letting it ship by default.
      expect(classified).toEqual(declared);
    });

    it('withholds the provenance columns (#296, D-296-1)', () => {
      const selected = scalarKeysOf(MEMBER_SELECT);

      expect(selected).not.toContain('origin');
      expect(selected).not.toContain('addedById');
    });

    it('publishes the roster scalars named by D-296-5', () => {
      expect(scalarKeysOf(MEMBER_SELECT).sort()).toEqual(
        ['createdAt', 'householdId', 'id', 'showAllGames', 'updatedAt', 'userId'].sort(),
      );
    });

    it('renders a member and an invite inviter as the same user shape', () => {
      // Agreement by test rather than by a shared constant: the roster's `user`
      // belongs to this lib and the inviter to `@bge/invites`, and neither
      // should import the other's notion of a user. What matters is that a
      // client sees one spelling of a user on the detail view, so that is
      // what is pinned.
      expect(CONTEXT_INVITE_SELECT.inviter.select).toEqual(MEMBER_SELECT.user.select);
    });
  });
});
