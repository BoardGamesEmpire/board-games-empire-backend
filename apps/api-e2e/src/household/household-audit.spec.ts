import { HouseholdMembershipOrigin, InviteStatus, ResourceType, SystemRole } from '@bge/database';
import type { Actors, AuthenticatedActor, HouseholdRoleName, SessionActor } from '@bge/testing-e2e';
import { arrangeInvite, createActors, pollUntil } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { acceptEnvelope, banEnvelope, inviteEnvelope } from './household-invite-wire';
import { createMemberClient } from './household-request';
import { createEnvelope } from './household-wire';

/**
 * A household's changes write an audit entry attributed to the user who made
 * each (#171, #245), against the running server and its audit listener: its
 * creation, edits, delete and restore, its membership and ban changes, the
 * ownership transfer, and each invite transition a user makes. Game-share
 * entries are outside #171 and aren't asserted here.
 *
 * Each household domain event names the household as its subject, membership
 * and ban changes included, so a test finds its entry by the household's id
 * and the domain event's name. Invite transitions are recorded by the invites
 * lib with the invite as their subject, so their entries are found by the
 * invite's id.
 *
 * The listener writes an entry after the request has answered, so an entry is
 * polled for, and an absent one means nothing until the entry of a later write
 * has landed, as `event/event-audit.ts` explains. Each test arranges its own
 * household before any of its actors sends a request, since the API caches
 * each user's ability on first use (#256).
 */
describe('household audit entries (#171, #245)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const HOUSEHOLDS_PATH = '/api/households';
  const { changeRole, leave, removeMember, transferOwnership } = createMemberClient(baseUrl);

  /** How long the audit listener may take to write an entry after the request has answered. */
  const AUDIT_ENTRY_LANDS_MS = 5_000;

  const CREATED = 'household.created';
  const UPDATED = 'household.updated';
  const DELETED = 'household.deleted';
  const RESTORED = 'household.restored';
  const OWNERSHIP_TRANSFERRED = 'household.ownership.transferred';
  const MEMBER_ADMITTED = 'household.member.admitted';
  const MEMBER_ROLE_CHANGED = 'household.member.role_changed';
  const MEMBER_REMOVED = 'household.member.removed';
  const BAN_CREATED = 'household.ban.created';
  const BAN_UPDATED = 'household.ban.updated';
  const BAN_LIFTED = 'household.ban.lifted';
  const INVITE_CREATED = 'invite.created';
  const INVITE_ACCEPTED = 'invite.accepted';
  const INVITE_DECLINED = 'invite.declined';
  const INVITE_WITHDRAWN = 'invite.withdrawn';
  const INVITE_REVOKED = 'invite.revoked';
  const INVITE_APPROVED = 'invite.approved';
  // No `invite.expired`: an expiry is the clock closing the invite, not a
  // user's choice, so it has no acting user to check (#171).

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const createHousehold = (actor: SessionActor, body: Record<string, unknown>) =>
    request(baseUrl).post(HOUSEHOLDS_PATH).set(actor.headers).send(body);

  const editHousehold = (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${HOUSEHOLDS_PATH}/${householdId}`).set(actor.headers).send(body);

  const deleteHousehold = (actor: SessionActor, householdId: string) =>
    request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${householdId}`).set(actor.headers);

  const restoreHousehold = (actor: SessionActor, householdId: string) =>
    request(baseUrl).post(`${HOUSEHOLDS_PATH}/${householdId}/restore`).set(actor.headers);

  const bansRoute = (householdId: string) => `${HOUSEHOLDS_PATH}/${householdId}/bans`;

  const banUser = (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(bansRoute(householdId)).set(actor.headers).send(body);

  const changeReason = (actor: SessionActor, householdId: string, userId: string, reason: string | null) =>
    request(baseUrl)
      .patch(`${bansRoute(householdId)}/${userId}`)
      .set(actor.headers)
      .send({ reason });

  const liftBan = (actor: SessionActor, householdId: string, userId: string) =>
    request(baseUrl)
      .delete(`${bansRoute(householdId)}/${userId}`)
      .set(actor.headers);

  /** An invite by id that `actor` sends through the route, which records its creation. */
  const sendInvite = async (actor: SessionActor, householdId: string, inviteeId: string) =>
    inviteEnvelope(
      await request(baseUrl)
        .post(`${HOUSEHOLDS_PATH}/${householdId}/invites`)
        .set(actor.headers)
        .send({ inviteeId })
        .expect(201),
      'POST /api/households/:id/invites',
    ).invite;

  const declineInvite = (actor: SessionActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/decline`).set(actor.headers);

  const withdrawInvite = (actor: SessionActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/withdraw`).set(actor.headers);

  const revokeInvite = (actor: SessionActor, householdId: string, inviteId: string) =>
    request(baseUrl).post(`${HOUSEHOLDS_PATH}/${householdId}/invites/${inviteId}/revoke`).set(actor.headers);

  const approveInvite = (actor: SessionActor, householdId: string, inviteId: string) =>
    request(baseUrl).post(`${HOUSEHOLDS_PATH}/${householdId}/invites/${inviteId}/approve`).set(actor.headers);

  /** The audit entries for one domain event on one subject, oldest first. */
  const auditEntries = (subject: ResourceType, subjectId: string, event: string) =>
    db.client.auditLog.findMany({ where: { subject, subjectId, event }, orderBy: { occurredAt: 'asc' } });

  /** The audit entries for one domain event on one subject, oldest first, once there are `count` of them. */
  const auditEntriesOnce = (subject: ResourceType, subjectId: string, event: string, count = 1) =>
    pollUntil(
      async () => {
        const entries = await auditEntries(subject, subjectId, event);

        return entries.length >= count ? entries : undefined;
      },
      {
        description: `${count} ${event} audit entries for ${subject} ${subjectId}`,
        timeoutMs: AUDIT_ENTRY_LANDS_MS,
      },
    );

  /** The household's audit entries for `event`, oldest first, once there are `count` of them. */
  const householdEntriesOnce = (householdId: string, event: string, count = 1) =>
    auditEntriesOnce(ResourceType.Household, householdId, event, count);

  /** The invite's audit entries for `event`, oldest first, once there is one. */
  const inviteEntriesOnce = (inviteId: string, event: string) => auditEntriesOnce(ResourceType.Invite, inviteId, event);

  /** The columns that say who made a change: a signed-in user, by id (#171). */
  const attributedTo = (actor: AuthenticatedActor) => ({ actorKind: 'user', actorUserId: actor.user.id });

  /** A household with its owner and one more user for each role in `others`, in that order. */
  const household = async (...others: HouseholdRoleName[]) => {
    const [owner, ...rest] = await Promise.all([actors.user(), ...others.map(() => actors.user())]);
    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Audited household',
      members: others.map((role, index) => ({ actor: rest[index], role })),
    });

    return {
      householdId: fixture.household.id,
      owner,
      ownerMemberId: fixture.owner.member.id,
      others: fixture.members.map((entry, index) => ({ actor: rest[index], memberId: entry.member.id })),
    };
  };

  it('records a created household as a create by its founder, and a replayed create not again (#171, #210)', async () => {
    const founder = await actors.user();
    const body = { name: 'Created and audited', clientRequestId: `e2e-key-${randomUUID()}` };

    const { household: created } = createEnvelope(
      await createHousehold(founder, body).expect(201),
      'POST /api/households',
    );

    await expect(householdEntriesOnce(created.id, CREATED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(founder),
        action: 'create',
        payload: { before: null, after: expect.objectContaining({ id: created.id, name: body.name }) },
      }),
    ]);

    const { household: replayed } = createEnvelope(
      await createHousehold(founder, body).expect(201),
      'POST /api/households (replay)',
    );

    // The replay answered with the household the first create made, so a
    // single entry below means no second household was created either (#210).
    expect(replayed.id).toBe(created.id);

    // The replay's entry, had it written one, would land before this later
    // edit's, so once the edit's entry is in, the count is final.
    await editHousehold(founder, created.id, { name: 'Edited after the replay' }).expect(200);
    await householdEntriesOnce(created.id, UPDATED);

    await expect(auditEntries(ResourceType.Household, created.id, CREATED)).resolves.toHaveLength(1);
  });

  it('records an edit with only the columns it changed, and an edit that changes nothing not at all (#171, #728)', async () => {
    const { householdId, owner } = await household();

    await editHousehold(owner, householdId, { name: 'Renamed' }).expect(200);

    await expect(householdEntriesOnce(householdId, UPDATED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(owner),
        action: 'update',
        payload: {
          before: { id: householdId, name: 'Audited household' },
          after: { id: householdId, name: 'Renamed' },
        },
      }),
    ]);

    await editHousehold(owner, householdId, { name: 'Renamed' }).expect(200);

    // A later edit's entry would land after any the identical one wrote, so
    // the second entry is the later edit's only if the identical one wrote
    // none.
    await editHousehold(owner, householdId, { description: 'Edited after the identical one' }).expect(200);
    const entries = await householdEntriesOnce(householdId, UPDATED, 2);

    expect(entries.map(({ payload }) => payload)).toEqual([
      { before: { id: householdId, name: 'Audited household' }, after: { id: householdId, name: 'Renamed' } },
      {
        before: { id: householdId, description: null },
        after: { id: householdId, description: 'Edited after the identical one' },
      },
    ]);
  });

  it("records an owner's delete as a delete, naming the owners it gave a restore window (#171, #175)", async () => {
    const { householdId, owner } = await household(SystemRole.HouseholdMember);

    await deleteHousehold(owner, householdId).expect(200);

    // Only owners get a restore window, so the member is not named.
    await expect(householdEntriesOnce(householdId, DELETED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(owner),
        action: 'delete',
        payload: {
          before: { id: householdId, name: 'Audited household', restoreWindowUserIds: [owner.user.id] },
          after: null,
        },
      }),
    ]);
  });

  it('records a restore, ending the restore windows the delete gave (#171, #175)', async () => {
    const { householdId, owner } = await household();
    await deleteHousehold(owner, householdId).expect(200);
    const { deletedAt } = await db.client.household.findUniqueOrThrow({
      where: { id: householdId },
      select: { deletedAt: true },
    });
    expect(deletedAt).toBeInstanceOf(Date);

    await restoreHousehold(owner, householdId).expect(200);

    await expect(householdEntriesOnce(householdId, RESTORED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(owner),
        action: 'update',
        payload: {
          before: { id: householdId, deletedAt: deletedAt?.toISOString(), restoreWindowUserIds: [owner.user.id] },
          after: { id: householdId, deletedAt: null, restoreWindowUserIds: [] },
        },
      }),
    ]);
  });

  it("records a member's role change, from the role they had to the one they were given (#171, #760)", async () => {
    const {
      householdId,
      owner,
      others: [member],
    } = await household(SystemRole.HouseholdMember);
    const membership = { householdId, userId: member.actor.user.id, memberId: member.memberId };

    await changeRole(owner, householdId, member.memberId, SystemRole.HouseholdAdmin).expect(200);

    await expect(householdEntriesOnce(householdId, MEMBER_ROLE_CHANGED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(owner),
        action: 'update',
        payload: {
          before: { ...membership, role: SystemRole.HouseholdMember },
          after: { ...membership, role: SystemRole.HouseholdAdmin },
        },
      }),
    ]);
  });

  it('records an ownership transfer as an update by the owner who transferred it, not the new owner (#171, #158)', async () => {
    const {
      householdId,
      owner,
      ownerMemberId,
      others: [heir],
    } = await household(SystemRole.HouseholdMember);

    await transferOwnership(owner, householdId, heir.memberId).expect(200);

    await expect(householdEntriesOnce(householdId, OWNERSHIP_TRANSFERRED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(owner),
        action: 'update',
        payload: {
          before: { householdId, ownerMemberId, ownerUserId: owner.user.id },
          after: { householdId, ownerMemberId: heir.memberId, ownerUserId: heir.actor.user.id },
        },
      }),
    ]);
  });

  it("records an accepted invite as the invitee's admission, and the accept itself as theirs (#171, #163)", async () => {
    const [{ householdId, owner }, invitee] = await Promise.all([household(), actors.user()]);
    const invite = await sendInvite(owner, householdId, invitee.user.id);

    const { member } = acceptEnvelope(
      await request(baseUrl).post(`/api/invites/${invite.id}/accept`).set(invitee.headers).expect(200),
      'POST /api/invites/:id/accept',
    );

    await expect(householdEntriesOnce(householdId, MEMBER_ADMITTED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(invitee),
        action: 'update',
        payload: {
          before: { householdId, userId: invitee.user.id, memberId: null, role: null },
          after: {
            householdId,
            userId: invitee.user.id,
            memberId: member.id,
            role: SystemRole.HouseholdMember,
            origin: HouseholdMembershipOrigin.InviteAccepted,
          },
        },
      }),
    ]);

    await expect(inviteEntriesOnce(invite.id, INVITE_ACCEPTED)).resolves.toEqual([
      expect.objectContaining({ ...attributedTo(invitee), action: 'update' }),
    ]);
  });

  // Each invite transition a user makes is recorded as theirs, through the
  // route that makes it. The creation has no before, so it is a create; every
  // later transition is an update of the invite (#171, #161).
  it('records an invite sent through the route as a create by its inviter, and its decline as an update by the invitee (#171, #164)', async () => {
    const [{ householdId, owner }, invitee] = await Promise.all([household(), actors.user()]);
    const invite = await sendInvite(owner, householdId, invitee.user.id);

    await expect(inviteEntriesOnce(invite.id, INVITE_CREATED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(owner),
        action: 'create',
        payload: { before: null, after: expect.objectContaining({ id: invite.id, status: InviteStatus.Pending }) },
      }),
    ]);

    await declineInvite(invitee, invite.id).expect(200);

    await expect(inviteEntriesOnce(invite.id, INVITE_DECLINED)).resolves.toEqual([
      expect.objectContaining({ ...attributedTo(invitee), action: 'update' }),
    ]);
  });

  it('records a withdrawn invite as an update by the inviter who withdrew it (#171, #164)', async () => {
    const [{ householdId, owner }, invitee] = await Promise.all([household(), actors.user()]);
    const invite = await sendInvite(owner, householdId, invitee.user.id);

    await withdrawInvite(owner, invite.id).expect(200);

    await expect(inviteEntriesOnce(invite.id, INVITE_WITHDRAWN)).resolves.toEqual([
      expect.objectContaining({ ...attributedTo(owner), action: 'update' }),
    ]);
  });

  it('records an invite revoked through the route as an update by the owner who revoked it, not the admin who sent it (#171, #164)', async () => {
    const [
      {
        householdId,
        owner,
        others: [admin],
      },
      invitee,
    ] = await Promise.all([household(SystemRole.HouseholdAdmin), actors.user()]);
    const invite = await sendInvite(admin.actor, householdId, invitee.user.id);

    await revokeInvite(owner, householdId, invite.id).expect(200);

    await expect(inviteEntriesOnce(invite.id, INVITE_REVOKED)).resolves.toEqual([
      expect.objectContaining({ ...attributedTo(owner), action: 'update' }),
    ]);
  });

  it('records an approved invite as an update by the admin who approved it, not the member who sent it (#171, #166)', async () => {
    const [
      {
        householdId,
        others: [admin, member],
      },
      invitee,
    ] = await Promise.all([household(SystemRole.HouseholdAdmin, SystemRole.HouseholdMember), actors.user()]);
    // A member's invite awaiting approval, arranged as the approval suite
    // arranges one.
    const waiting = await arrangeInvite(db.client, {
      inviter: member.actor,
      householdId,
      inviteeId: invitee.user.id,
      status: InviteStatus.AwaitingApproval,
    });

    await approveInvite(admin.actor, householdId, waiting.id).expect(200);

    await expect(inviteEntriesOnce(waiting.id, INVITE_APPROVED)).resolves.toEqual([
      expect.objectContaining({ ...attributedTo(admin.actor), action: 'update' }),
    ]);
  });

  it('records a member removed from the household as ended with cause removed, by the owner who removed them (#171, #157)', async () => {
    const {
      householdId,
      owner,
      others: [member],
    } = await household(SystemRole.HouseholdMember);
    const membership = { householdId, userId: member.actor.user.id };

    await removeMember(owner, householdId, member.memberId).expect(200);

    await expect(householdEntriesOnce(householdId, MEMBER_REMOVED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(owner),
        action: 'update',
        payload: {
          before: { ...membership, memberId: member.memberId, role: SystemRole.HouseholdMember },
          after: { ...membership, memberId: null, role: null, cause: 'removed' },
        },
      }),
    ]);
  });

  it('records a member leaving as ended with cause left, by the member who left (#171, #157)', async () => {
    const {
      householdId,
      others: [guest],
    } = await household(SystemRole.HouseholdGuest);
    const membership = { householdId, userId: guest.actor.user.id };

    await leave(guest.actor, householdId).expect(200);

    await expect(householdEntriesOnce(householdId, MEMBER_REMOVED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(guest.actor),
        action: 'update',
        payload: {
          before: { ...membership, memberId: guest.memberId, role: SystemRole.HouseholdGuest },
          after: { ...membership, memberId: null, role: null, cause: 'left' },
        },
      }),
    ]);
  });

  it("records a member's ban as their membership ended with cause banned, the ban with its reason, and their revoked invite, all by whoever banned them (#171, #782)", async () => {
    const {
      householdId,
      owner,
      others: [admin, member],
    } = await household(SystemRole.HouseholdAdmin, SystemRole.HouseholdMember);
    const target = { householdId, userId: member.actor.user.id };
    // An invite by id to a current member can't be made through the route;
    // it is the one left over from before another invite admitted them.
    const leftOver = await arrangeInvite(db.client, { inviter: owner, householdId, inviteeId: member.actor.user.id });

    const { ban } = banEnvelope(
      await banUser(admin.actor, householdId, { userId: member.actor.user.id, reason: 'Spoiled the ending' }).expect(
        201,
      ),
      'POST /api/households/:id/bans',
    );

    await expect(householdEntriesOnce(householdId, MEMBER_REMOVED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(admin.actor),
        action: 'update',
        payload: {
          before: { ...target, memberId: member.memberId, role: SystemRole.HouseholdMember },
          after: { ...target, memberId: null, role: null, cause: 'banned' },
        },
      }),
    ]);

    await expect(householdEntriesOnce(householdId, BAN_CREATED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(admin.actor),
        action: 'update',
        payload: {
          before: { ...target, banId: null, reason: null },
          after: { ...target, banId: ban.id, reason: 'Spoiled the ending' },
        },
      }),
    ]);

    await expect(inviteEntriesOnce(leftOver.id, INVITE_REVOKED)).resolves.toEqual([
      expect.objectContaining({ ...attributedTo(admin.actor), action: 'update' }),
    ]);
  });

  it("records a ban's reason change with the old and new reason, and its lift, each by whoever made it (#171, #782)", async () => {
    const [
      {
        householdId,
        owner,
        others: [admin],
      },
      stranger,
    ] = await Promise.all([household(SystemRole.HouseholdAdmin), actors.user()]);
    const target = { householdId, userId: stranger.user.id };
    const { ban } = banEnvelope(
      await banUser(owner, householdId, { userId: stranger.user.id, reason: 'first' }).expect(201),
      'POST /api/households/:id/bans',
    );
    const banned = { ...target, banId: ban.id };

    await changeReason(admin.actor, householdId, stranger.user.id, 'second').expect(200);

    await expect(householdEntriesOnce(householdId, BAN_UPDATED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(admin.actor),
        action: 'update',
        payload: { before: { ...banned, reason: 'first' }, after: { ...banned, reason: 'second' } },
      }),
    ]);

    await liftBan(owner, householdId, stranger.user.id).expect(200);

    await expect(householdEntriesOnce(householdId, BAN_LIFTED)).resolves.toEqual([
      expect.objectContaining({
        ...attributedTo(owner),
        action: 'update',
        payload: { before: { ...banned, reason: 'second' }, after: { ...target, banId: null, reason: null } },
      }),
    ]);
  });
});
