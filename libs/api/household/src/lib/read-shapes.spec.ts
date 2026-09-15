import { Prisma } from '@bge/database';
import {
  INVITE_SCALARS_OMITTED,
  MEMBER_SCALARS_OMITTED,
  MEMBER_SELECT,
  PENDING_INVITE_SELECT,
} from './read-shapes';

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
  });

  describe('PENDING_INVITE_SELECT', () => {
    it('classifies every Invite scalar as either selected or deliberately omitted', () => {
      const declared = Object.values(Prisma.InviteScalarFieldEnum).sort();
      const classified = [...scalarKeysOf(PENDING_INVITE_SELECT), ...Object.keys(INVITE_SCALARS_OMITTED)].sort();

      expect(classified).toEqual(declared);
    });

    it('never publishes the accept token', () => {
      // The whole of #297. `Invite.token` is a live accept credential, and this
      // shape is reached by every holder of `read:household` — which is every
      // member of the household.
      expect(scalarKeysOf(PENDING_INVITE_SELECT)).not.toContain('token');
      expect(INVITE_SCALARS_OMITTED).toHaveProperty('token');
    });

    it('never publishes the invitee email (D-297-2; the inviter-only question is #459)', () => {
      expect(scalarKeysOf(PENDING_INVITE_SELECT)).not.toContain('inviteeEmail');
      expect(INVITE_SCALARS_OMITTED).toHaveProperty('inviteeEmail');
    });

    it('publishes the invite scalars named by D-297-1', () => {
      expect(scalarKeysOf(PENDING_INVITE_SELECT).sort()).toEqual(
        ['createdAt', 'expiresAt', 'id', 'inviteeName', 'status', 'type'].sort(),
      );
    });

    it('renders the invited role as an object rather than a bare id (D-297-6)', () => {
      // A bare `roleId` would answer "which role" with an opaque identifier the
      // client must resolve, while the roster beside it renders `{ id, name }`.
      expect(scalarKeysOf(PENDING_INVITE_SELECT)).not.toContain('roleId');
      expect(PENDING_INVITE_SELECT.role).toEqual({ select: { id: true, name: true } });
    });
  });
});
