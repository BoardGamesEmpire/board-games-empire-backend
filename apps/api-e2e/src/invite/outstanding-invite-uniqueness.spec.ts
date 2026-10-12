import { constraintIdentity, InviteStatus, InviteType, isPrismaUniqueConstraintError, Prisma } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The database half of #161: a second outstanding invite to the
 * same person for the same context is refused by a partial unique index, and
 * a settled invite stands aside so a re-invite is allowed.
 *
 * Asserted against a REAL database because nothing else can assert it. The
 * indexes are hand-written in `20261012000000_invite_outstanding_unique`,
 * Prisma cannot model a partial index, and the schema does not mention them,
 * so no unit test and no generated type knows they exist. This file is what
 * makes their absence loud.
 *
 * It also pins the P2002 identity each index reports. `InviteService` maps a
 * duplicate to 409 by the raw column pair the driver adapter names, and
 * answers 409 for an UNIDENTIFIABLE P2002 on the strength of what `invites`
 * can collide on. Both halves of that reasoning are characterized here, on
 * the model of `apps/api-e2e/src/database/p2002-shape.spec.ts`.
 *
 * Rows are arranged directly rather than through an endpoint: the create
 * route is #162's, and the constraint has to hold whatever path inserts.
 */

/** SQLSTATE unique_violation. */
const SQLSTATE_UNIQUE_VIOLATION = '23505';

/** The four partial indexes, as the migration names them. */
const OUTSTANDING_INDEXES = [
  'invites_event_invitee_email_outstanding_unique',
  'invites_event_invitee_outstanding_unique',
  'invites_household_invitee_email_outstanding_unique',
  'invites_household_invitee_outstanding_unique',
] as const;

/** `Invite.token`'s `@unique`, as Prisma names it. */
const TOKEN_INDEX = 'invites_token_key';

const describePayload = (error: unknown): string => inspect(error, { depth: null, showHidden: true, getters: true });

async function captureUniqueViolation(
  operation: () => Promise<unknown>,
  what: string,
): Promise<Prisma.PrismaClientKnownRequestError> {
  let caught: unknown;

  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(
      `Expected a unique violation from ${what}, but nothing threw. The partial index is missing from the applied ` +
        `migration set, or the arrangement no longer produces a duplicate.`,
    );
  }

  if (!isPrismaUniqueConstraintError(caught)) {
    throw new Error(`Expected a P2002 from ${what}, got: ${describePayload(caught)}.`);
  }

  return caught;
}

describe('outstanding invite uniqueness (#161)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  interface InviteArrangement {
    readonly inviter: SessionActor;
    /** One context or the other; the invite's type follows from which is given. */
    readonly householdId?: string | null;
    readonly eventId?: string | null;
    readonly inviteeId?: string | null;
    readonly inviteeEmail?: string | null;
    readonly status?: InviteStatus;
  }

  /**
   * Arranges an invite directly, as `household-lifecycle.spec.ts` does. The
   * token is random because it is unique-constrained and the between-test
   * sweep must not let one test's row collide with the next (#268).
   */
  const arrangeInvite = ({
    inviter,
    householdId = null,
    eventId = null,
    inviteeId = null,
    inviteeEmail = null,
    status = InviteStatus.Pending,
  }: InviteArrangement) =>
    db.client.invite.create({
      data: {
        type: eventId === null ? InviteType.Household : InviteType.Event,
        status,
        inviterId: inviter.user.id,
        householdId,
        eventId,
        inviteeId,
        inviteeEmail,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      },
      select: { id: true },
    });

  const settle = (id: string, status: InviteStatus) =>
    db.client.invite.update({ where: { id }, data: { status, respondedAt: new Date() }, select: { id: true } });

  const arrange = async () => {
    const inviter = await actors.user();
    const invitee = await actors.user();
    const fixture = await actors.householdWithMembers({ owner: inviter, name: 'Uniqueness probe household' });

    return { inviter, inviteeId: invitee.user.id, householdId: fixture.household.id };
  };

  /** An event of the inviter's, for the pair of indexes keyed on `event_id`. */
  const arrangeEvent = async () => {
    const { inviter, inviteeId, householdId } = await arrange();
    const event = await db.client.event.create({
      data: { title: 'Uniqueness probe event', createdById: inviter.user.id, householdId },
      select: { id: true },
    });

    return { inviter, inviteeId, eventId: event.id };
  };

  describe('a user-bound invite', () => {
    it('refuses a second outstanding invite to the same user, naming the household and invitee columns', async () => {
      const { inviter, inviteeId, householdId } = await arrange();

      await arrangeInvite({ inviter, householdId, inviteeId });

      const error = await captureUniqueViolation(
        () => arrangeInvite({ inviter, householdId, inviteeId }),
        'a second Pending invite to the same user for the same household',
      );

      // The identity `InviteService.translateCreateFailure` maps to 409. The
      // raw column pair, from the driver adapter, is what ships on this stack.
      expect(constraintIdentity(error)).toEqual({
        source: 'driverAdapterError.fields',
        names: ['household_id', 'invitee_id'],
        sqlState: SQLSTATE_UNIQUE_VIOLATION,
      });
    });

    it('counts an AwaitingApproval invite as outstanding', async () => {
      const { inviter, inviteeId, householdId } = await arrange();

      await arrangeInvite({ inviter, householdId, inviteeId, status: InviteStatus.AwaitingApproval });

      await captureUniqueViolation(
        () => arrangeInvite({ inviter, householdId, inviteeId }),
        'a Pending invite beside an AwaitingApproval one to the same user',
      );
    });

    it('allows a re-invite once the first was declined, as a new row', async () => {
      const { inviter, inviteeId, householdId } = await arrange();

      const first = await arrangeInvite({ inviter, householdId, inviteeId });
      await settle(first.id, InviteStatus.Declined);

      const second = await arrangeInvite({ inviter, householdId, inviteeId });

      expect(second.id).not.toBe(first.id);
      await expect(db.client.invite.count({ where: { householdId, inviteeId } })).resolves.toBe(2);
    });

    it.each([InviteStatus.Revoked, InviteStatus.Withdrawn, InviteStatus.Expired, InviteStatus.Accepted])(
      'allows a re-invite once the first is %s',
      async (status) => {
        const { inviter, inviteeId, householdId } = await arrange();

        const first = await arrangeInvite({ inviter, householdId, inviteeId });
        await settle(first.id, status);

        await expect(arrangeInvite({ inviter, householdId, inviteeId })).resolves.toEqual({ id: expect.any(String) });
      },
    );

    it('leaves the same user free to hold an outstanding invite to a different household', async () => {
      const { inviter, inviteeId, householdId } = await arrange();
      const other = await actors.householdWithMembers({ owner: inviter, name: 'Another household' });

      await arrangeInvite({ inviter, householdId, inviteeId });

      await expect(arrangeInvite({ inviter, householdId: other.household.id, inviteeId })).resolves.toEqual({
        id: expect.any(String),
      });
    });
  });

  describe('an email-only invite', () => {
    it('refuses a second outstanding invite to the same address, naming the household and email columns', async () => {
      const { inviter, householdId } = await arrange();
      const inviteeEmail = `invitee-${randomUUID()}@e2e.invalid`;

      await arrangeInvite({ inviter, householdId, inviteeEmail });

      const error = await captureUniqueViolation(
        () => arrangeInvite({ inviter, householdId, inviteeEmail }),
        'a second Pending invite to the same address for the same household',
      );

      expect(constraintIdentity(error)).toEqual({
        source: 'driverAdapterError.fields',
        names: ['household_id', 'invitee_email'],
        sqlState: SQLSTATE_UNIQUE_VIOLATION,
      });
    });

    it('allows a re-invite once the first expired', async () => {
      const { inviter, householdId } = await arrange();
      const inviteeEmail = `invitee-${randomUUID()}@e2e.invalid`;

      const first = await arrangeInvite({ inviter, householdId, inviteeEmail });
      await settle(first.id, InviteStatus.Expired);

      await expect(arrangeInvite({ inviter, householdId, inviteeEmail })).resolves.toEqual({ id: expect.any(String) });
    });

    it('does not collide with a user-bound invite: NULLs are distinct under both indexes', async () => {
      // An email-only row has no invitee id, a user-bound row no address.
      // Each index sees a NULL on one side, and a unique index never matches
      // two NULLs, so the two kinds of invite cannot block each other.
      const { inviter, inviteeId, householdId } = await arrange();

      await arrangeInvite({ inviter, householdId, inviteeId });

      await expect(
        arrangeInvite({ inviter, householdId, inviteeEmail: `invitee-${randomUUID()}@e2e.invalid` }),
      ).resolves.toEqual({ id: expect.any(String) });
    });
  });

  describe('an event-bound invite', () => {
    // The event pair of indexes is hand-written like the household pair, and
    // the service maps their P2002 the same way. The catalog assertion below
    // sees names and predicates only, so the columns each one holds and the
    // identity each one reports are pinned here, by a real collision.
    it('refuses a second outstanding invite to the same user, naming the event and invitee columns', async () => {
      const { inviter, inviteeId, eventId } = await arrangeEvent();

      await arrangeInvite({ inviter, eventId, inviteeId });

      const error = await captureUniqueViolation(
        () => arrangeInvite({ inviter, eventId, inviteeId }),
        'a second Pending invite to the same user for the same event',
      );

      expect(constraintIdentity(error)).toEqual({
        source: 'driverAdapterError.fields',
        names: ['event_id', 'invitee_id'],
        sqlState: SQLSTATE_UNIQUE_VIOLATION,
      });
    });

    it('refuses a second outstanding invite to the same address, naming the event and email columns', async () => {
      const { inviter, eventId } = await arrangeEvent();
      const inviteeEmail = `invitee-${randomUUID()}@e2e.invalid`;

      await arrangeInvite({ inviter, eventId, inviteeEmail });

      const error = await captureUniqueViolation(
        () => arrangeInvite({ inviter, eventId, inviteeEmail }),
        'a second Pending invite to the same address for the same event',
      );

      expect(constraintIdentity(error)).toEqual({
        source: 'driverAdapterError.fields',
        names: ['event_id', 'invitee_email'],
        sqlState: SQLSTATE_UNIQUE_VIOLATION,
      });
    });
  });

  /**
   * The guard that keeps `InviteService`'s `unknown` fallback honest.
   *
   * That fallback answers 409 for an unidentifiable P2002 because the insert
   * can reach exactly these uniques besides the primary key: the token, which
   * the service probed free a statement earlier, and the four partial indexes
   * on an outstanding invite. A fifth unique on `invites` breaks the reasoning
   * rather than merely widening the list, so this must fail rather than be
   * updated reflexively.
   *
   * `pg_index` rather than `pg_constraint`, for the reason `p2002-shape.spec.ts`
   * gives: Prisma declares uniqueness as indexes, which `pg_constraint` never
   * sees. `indpred` is what makes the four partial: a predicate is what
   * confines them to outstanding rows, so a rebuilt index that lost its `WHERE`
   * would refuse every re-invite and fail here.
   */
  it('holds invites to the token unique plus the four outstanding partial indexes', async () => {
    const relation = `${db.schema}.invites`;

    const [resolution] = await db.client.$queryRaw<{ found: boolean }[]>`
      SELECT to_regclass(${relation}) IS NOT NULL AS found
    `;

    if (resolution?.found !== true) {
      throw new Error(
        `Could not resolve '${relation}' in the test database, so this assertion cannot say anything about its ` +
          `uniqueness rules. Check that migrations ran against this schema before reading the list below as a ` +
          `schema change.`,
      );
    }

    const indexes = await db.client.$queryRaw<{ name: string; isPrimary: boolean; isPartial: boolean }[]>`
      SELECT i.relname::text AS name, ix.indisprimary AS "isPrimary", ix.indpred IS NOT NULL AS "isPartial"
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE ix.indrelid = to_regclass(${relation})
        AND ix.indisunique
      ORDER BY i.relname
    `;

    const uniques = indexes.filter((row) => !row.isPrimary);

    expect(uniques.map((row) => row.name)).toEqual([...OUTSTANDING_INDEXES, TOKEN_INDEX].sort());
    expect(uniques.filter((row) => row.isPartial).map((row) => row.name)).toEqual([...OUTSTANDING_INDEXES]);
    expect(uniques.find((row) => row.name === TOKEN_INDEX)?.isPartial).toBe(false);
  });
});
