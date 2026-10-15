import { InviteStatus, InviteType, SystemRole } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { inviteEnvelope, receivedInvitesEnvelope } from './household-invite-wire';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The invitee's inbox, `GET /api/invites` (#163): the household invites the
 * caller could accept right now, by their user id or by their verified
 * address, and nothing else.
 */
describe('household invite inbox', () => {
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

  const inbox = (actor: AuthenticatedActor) => request(baseUrl).get('/api/invites').set(actor.headers);

  const received = async (actor: SessionActor) =>
    receivedInvitesEnvelope(await inbox(actor).expect(200), 'GET /api/invites');

  const createdInvite = async (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(
      await request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body).expect(201),
      'POST /api/households/:id/invites',
    ).invite;

  const verify = (actor: SessionActor) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { emailVerified: true } });

  /** An invite written directly, for a state no route produces. */
  const arrangeInvite = (
    inviter: SessionActor,
    householdId: string,
    data: {
      inviteeId?: string;
      inviteeEmail?: string;
      status?: InviteStatus;
      expiresAt?: Date;
      withheld?: boolean;
    },
  ) =>
    db.client.invite.create({
      data: {
        type: InviteType.Household,
        inviterId: inviter.user.id,
        householdId,
        token: randomUUID(),
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + DAY_MS),
        ...data,
      },
    });

  const ownedHousehold = async (name: string) => {
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner, name });

    return { owner, household };
  };

  it('lists the invites by id and to a verified address, newest first, each naming its household', async () => {
    const invitee = await actors.user();
    const byId = await ownedHousehold(`By id ${randomUUID()}`);
    const byAddress = await ownedHousehold(`By address ${randomUUID()}`);
    await verify(invitee);

    const first = await createdInvite(byId.owner, byId.household.id, { inviteeId: invitee.user.id, message: 'Hi' });
    const second = await createdInvite(byAddress.owner, byAddress.household.id, {
      inviteeEmail: invitee.user.email.toUpperCase(),
    });

    const { invites, pagination } = await received(invitee);

    expect(invites.map((invite) => invite.id)).toEqual([second.id, first.id]);
    expect(pagination).toMatchObject({ page: 1, total: 2, hasMore: false });
    expect(invites[0]).toMatchObject({
      status: InviteStatus.Pending,
      inviteeEmail: invitee.user.email,
      household: { id: byAddress.household.id, name: byAddress.household.name },
      inviter: { id: byAddress.owner.user.id },
      role: { name: SystemRole.HouseholdMember },
    });
    expect(invites[1]).toMatchObject({
      inviteeEmail: null,
      message: 'Hi',
      household: { id: byId.household.id, name: byId.household.name },
    });
    for (const invite of invites) {
      expect(invite).not.toHaveProperty('token');
      expect(invite).not.toHaveProperty('householdId');
      expect(invite).not.toHaveProperty('withheld');
    }
  });

  it('leaves out withheld, settled and expired invites, those into households closed to them, and their own', async () => {
    const invitee = await actors.user();
    await verify(invitee);
    const { owner, household } = await ownedHousehold(`Elsewhere ${randomUUID()}`);
    const { household: theirs } = await actors.householdWithMembers({
      owner: await actors.user(),
      members: [{ actor: invitee, role: SystemRole.HouseholdMember }],
    });
    const { owner: goneOwner, household: gone } = await ownedHousehold(`Gone ${randomUUID()}`);
    await db.client.household.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    // Live, and not theirs, so only who sent the invite into it can hide it.
    const { household: open } = await ownedHousehold(`Open ${randomUUID()}`);

    // Withheld: a block or the invitee's preference refused it (#278).
    await arrangeInvite(owner, household.id, { inviteeEmail: invitee.user.email, withheld: true });
    // Expired, though its row still says Pending.
    await arrangeInvite(owner, household.id, {
      inviteeId: invitee.user.id,
      expiresAt: new Date(Date.now() - DAY_MS),
    });
    await arrangeInvite(owner, household.id, { inviteeId: invitee.user.id, status: InviteStatus.Declined });
    // Into a household they already belong to: its accept would be refused.
    await arrangeInvite(owner, theirs.id, { inviteeEmail: invitee.user.email });
    // Into a deleted household.
    await arrangeInvite(goneOwner, gone.id, { inviteeId: invitee.user.id });
    // One they sent, to an address that is their own.
    await arrangeInvite(invitee, open.id, { inviteeEmail: invitee.user.email });

    const { invites, pagination } = await received(invitee);

    expect(invites).toEqual([]);
    expect(pagination.total).toBe(0);
  });

  it('matches no invite by address until the address is verified', async () => {
    const invitee = await actors.user();
    const { owner, household } = await ownedHousehold(`Unverified ${randomUUID()}`);
    const invite = await createdInvite(owner, household.id, { inviteeEmail: invitee.user.email });

    expect((await received(invitee)).invites).toEqual([]);

    await verify(invitee);

    expect((await received(invitee)).invites.map((row) => row.id)).toEqual([invite.id]);
  });

  it('refuses an anonymous guest with 403', async () => {
    const guest = await actors.anonymous();

    await inbox(guest).expect(403);
  });
});
