import { Prisma, SystemRole } from '@bge/database';
import { CONTEXT_INVITE_SELECT } from '@bge/invites';
import {
  ADMIN_HOUSEHOLD_ROW_SELECT,
  HOUSEHOLD_SCALARS_OMITTED_FROM_ADMIN_ROW,
  HOUSEHOLD_SETTINGS_SCALARS_OMITTED,
  HOUSEHOLD_SETTINGS_SELECT,
  MEMBER_SCALARS_OMITTED,
  MEMBER_SELECT,
} from './read-shapes';
import { SHOWN_NAME_SELECT } from './shown-name';

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
      // client sees one spelling of a user across the household's roster and
      // its invite list, so that is what is pinned.
      expect(CONTEXT_INVITE_SELECT.inviter.select).toEqual(MEMBER_SELECT.user.select);
    });
  });

  describe('HOUSEHOLD_SETTINGS_SELECT (#166)', () => {
    it('classifies every HouseholdSettings scalar as either selected or deliberately omitted', () => {
      const declared = Object.values(Prisma.HouseholdSettingsScalarFieldEnum).sort();
      const classified = [
        ...scalarKeysOf(HOUSEHOLD_SETTINGS_SELECT),
        ...Object.keys(HOUSEHOLD_SETTINGS_SCALARS_OMITTED),
      ].sort();

      // A new setting lands here first: publish it or withhold it, with the reason.
      expect(classified).toEqual(declared);
    });

    it('publishes the member invite policy, which a member needs to know whether they may invite', () => {
      expect(scalarKeysOf(HOUSEHOLD_SETTINGS_SELECT)).toContain('memberInvitePolicy');
    });

    it('publishes the member share policy, which a member needs to know whether they may share (#810)', () => {
      expect(scalarKeysOf(HOUSEHOLD_SETTINGS_SELECT)).toContain('memberSharePolicy');
    });
  });

  describe('ADMIN_HOUSEHOLD_ROW_SELECT (#419)', () => {
    it('classifies every Household scalar as either selected or deliberately omitted', () => {
      const declared = Object.values(Prisma.HouseholdScalarFieldEnum).sort();
      const classified = [
        ...scalarKeysOf(ADMIN_HOUSEHOLD_ROW_SELECT),
        ...Object.keys(HOUSEHOLD_SCALARS_OMITTED_FROM_ADMIN_ROW),
      ].sort();

      // A new Household column lands here first: publish it on the staff
      // households list, or withhold it with the reason.
      expect(classified).toEqual(declared);
    });

    it('publishes the row scalars the staff households list shows', () => {
      expect(scalarKeysOf(ADMIN_HOUSEHOLD_ROW_SELECT).sort()).toEqual(
        ['createdAt', 'deletedAt', 'id', 'image', 'name', 'reach'].sort(),
      );
    });

    // A list of every household on the server shouldn't carry every member
    // (client#683): the row names its household owners and counts the rest.
    it('lists the household owners only, never the full roster', () => {
      expect(ADMIN_HOUSEHOLD_ROW_SELECT.members.where).toEqual({ role: { role: { name: SystemRole.HouseholdOwner } } });
      expect(ADMIN_HOUSEHOLD_ROW_SELECT._count).toEqual({ select: { members: true } });
    });

    it('reads each owner’s username and display name, and nothing else of the user', () => {
      expect(ADMIN_HOUSEHOLD_ROW_SELECT.members.select.user.select).toBe(SHOWN_NAME_SELECT);
    });
  });
});
