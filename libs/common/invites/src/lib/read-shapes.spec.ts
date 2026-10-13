import { Prisma } from '@bge/database';
import { INVITE_SNAPSHOT_FIELDS } from './events/invite.events';
import {
  CONTEXT_INVITE_SELECT,
  INVITE_SCALARS_OMITTED,
  INVITE_SCALARS_PARTY_ONLY,
  INVITE_SNAPSHOT_SELECT,
  PARTY_INVITE_SELECT,
  TRANSITION_SELECT,
} from './read-shapes';

/**
 * The scalar keys of a select object: the ones written `field: true`, as
 * opposed to the relation keys, which carry a nested `select`.
 *
 * Reading the shape rather than being handed a list is the point: a scalar
 * added to the select is counted here whether or not anyone updated a fixture.
 */
const scalarKeysOf = (select: Record<string, unknown>): string[] =>
  Object.entries(select)
    .filter(([, value]) => value === true)
    .map(([key]) => key);

/**
 * `#297`, moved here from `@bge/household` by #161. Prisma's `include:`
 * returns every scalar on the model, and the routes that return invites have
 * no `ClassSerializerInterceptor`, so a column added to the model reached
 * clients without anyone choosing to publish it. That is how `Invite.token`
 * became public.
 *
 * These specs are the guard that stops it recurring. They read the model's
 * scalars out of the GENERATED client rather than a hand-written list, so
 * adding a column to `prisma/models` fails them until someone classifies it as
 * published, party-only, or deliberately withheld.
 */
describe('invite read shapes', () => {
  const declared = Object.values(Prisma.InviteScalarFieldEnum).sort();

  describe('CONTEXT_INVITE_SELECT (context shape)', () => {
    it('classifies every Invite scalar as selected, party-only, or deliberately omitted', () => {
      const classified = [
        ...scalarKeysOf(CONTEXT_INVITE_SELECT),
        ...Object.keys(INVITE_SCALARS_PARTY_ONLY),
        ...Object.keys(INVITE_SCALARS_OMITTED),
      ].sort();

      // A new column lands here first. Publish it by adding it to
      // CONTEXT_INVITE_SELECT, confine it to the parties through
      // INVITE_SCALARS_PARTY_ONLY, or withhold it through INVITE_SCALARS_OMITTED
      // with the reason. Decide, rather than letting it ship by default.
      expect(classified).toEqual(declared);
    });

    it('never publishes the accept token', () => {
      // The whole of #297. `Invite.token` is a live accept credential, and this
      // shape is reached by every holder of `read:household`: every member of
      // the household, plus any member's friend on a `Friends`-visible one.
      expect(scalarKeysOf(CONTEXT_INVITE_SELECT)).not.toContain('token');
      expect(INVITE_SCALARS_OMITTED).toHaveProperty('token');
    });

    it('never publishes the invitee email to a context reader (#297)', () => {
      expect(scalarKeysOf(CONTEXT_INVITE_SELECT)).not.toContain('inviteeEmail');
      expect(INVITE_SCALARS_PARTY_ONLY).toHaveProperty('inviteeEmail');
    });

    it('publishes the invite scalars #297 named', () => {
      expect(scalarKeysOf(CONTEXT_INVITE_SELECT).sort()).toEqual(
        ['createdAt', 'expiresAt', 'id', 'inviteeName', 'status', 'type'].sort(),
      );
    });

    it('renders the invited role as an object rather than a bare id (#297)', () => {
      // A bare `roleId` would answer "which role" with an opaque identifier the
      // client must resolve, while a roster beside it renders `{ id, name }`.
      expect(scalarKeysOf(CONTEXT_INVITE_SELECT)).not.toContain('roleId');
      expect(CONTEXT_INVITE_SELECT.role).toEqual({ select: { id: true, name: true } });
    });
  });

  describe('PARTY_INVITE_SELECT (party shape)', () => {
    it('classifies every Invite scalar as selected or deliberately omitted', () => {
      const classified = [...scalarKeysOf(PARTY_INVITE_SELECT), ...Object.keys(INVITE_SCALARS_OMITTED)].sort();

      expect(classified).toEqual(declared);
    });

    it('is the context shape plus exactly the party-only columns (#161)', () => {
      const extra = scalarKeysOf(PARTY_INVITE_SELECT).filter(
        (key) => !scalarKeysOf(CONTEXT_INVITE_SELECT).includes(key),
      );

      expect(extra.sort()).toEqual(Object.keys(INVITE_SCALARS_PARTY_ONLY).sort());
      expect(PARTY_INVITE_SELECT.role).toEqual(CONTEXT_INVITE_SELECT.role);
      expect(PARTY_INVITE_SELECT.inviter).toEqual(CONTEXT_INVITE_SELECT.inviter);
    });

    it('still never publishes the accept token', () => {
      // A party shape is handed to the invitee, who holds the token already
      // when they came by link, and to the inviter, who must never see it: an
      // inviter holding the credential could accept on the invitee's behalf.
      expect(scalarKeysOf(PARTY_INVITE_SELECT)).not.toContain('token');
    });
  });

  describe('INVITE_SNAPSHOT_SELECT (domain event payload)', () => {
    it('selects exactly the snapshot fields a domain event carries', () => {
      expect(scalarKeysOf(INVITE_SNAPSHOT_SELECT).sort()).toEqual([...INVITE_SNAPSHOT_FIELDS].sort());
    });

    it('never selects the token', () => {
      expect(scalarKeysOf(INVITE_SNAPSHOT_SELECT)).not.toContain('token');
    });
  });

  describe('TRANSITION_SELECT (what a transition reads)', () => {
    it('is a superset of both client shapes, so a projection never reads a missing key', () => {
      const transitionKeys = Object.keys(TRANSITION_SELECT);

      for (const key of Object.keys(PARTY_INVITE_SELECT)) {
        expect(transitionKeys).toContain(key);
      }
      for (const key of Object.keys(CONTEXT_INVITE_SELECT)) {
        expect(transitionKeys).toContain(key);
      }
    });

    it('is a superset of the snapshot, so every domain event field is on the row', () => {
      for (const field of INVITE_SNAPSHOT_FIELDS) {
        expect(TRANSITION_SELECT).toHaveProperty(field, true);
      }
    });

    it('never selects the token, so no transition can leak it by accident', () => {
      expect(scalarKeysOf(TRANSITION_SELECT)).not.toContain('token');
    });
  });
});
