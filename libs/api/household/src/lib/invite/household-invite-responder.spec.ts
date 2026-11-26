import {
  Action,
  HouseholdMembershipOrigin,
  InviteStatus,
  InviteType,
  MemberInvitePolicy,
  QuotaScope,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { CodedHttpException } from '@bge/i18n';
import type {
  InviteAcceptance,
  InviteDeclination,
  InviteOffer,
  InvitePartyView,
  InviteRevocation,
  InviteWithdrawal,
} from '@bge/invites';
import { InviteService } from '@bge/invites';
import type { UserAbilityCheck } from '@bge/permissions';
import { AbilityService, PermissionsService } from '@bge/permissions';
import type { QuotaSoftOverageEvent } from '@bge/quota';
import { QuotaService } from '@bge/quota';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, unwrapTransaction } from '@bge/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AddMemberResult, HouseholdMemberWithRelations } from '../member/household-member.service';
import { HouseholdMemberService } from '../member/household-member.service';
import { HouseholdInviteResponder } from './household-invite-responder';

const INVITEE_ID = 'user-invitee';
const INVITER_ID = 'user-inviter';
const HOUSEHOLD_ID = 'hh-1';
const ADDRESS = 'sam@example.test';
const LATER = new Date('2099-01-01T00:00:00Z');
const NOW = new Date('2026-10-15T12:00:00Z');

const partyView = (overrides: Partial<InvitePartyView> = {}): InvitePartyView => ({
  id: 'invite-1',
  status: InviteStatus.Accepted,
  type: InviteType.Household,
  inviteeName: 'Sam',
  expiresAt: LATER,
  createdAt: NOW,
  role: { id: 'role-admin', name: SystemRole.HouseholdAdmin },
  inviter: { id: INVITER_ID, username: 'inviter', profile: null },
  inviteeEmail: ADDRESS,
  message: null,
  ...overrides,
});

const OVERAGE: QuotaSoftOverageEvent = {
  scope: QuotaScope.Household,
  scopeId: HOUSEHOLD_ID,
  resource: 'household_member_count',
  currentUsage: '8',
  attemptedAmount: '1',
  limit: '8',
};

/** Prisma's delegate types want full rows; the responder selects narrower ones. */
const resolves = (value: unknown) => value as never;

/** The membership the accept makes, as the admission seam returns it. */
const NEW_MEMBER: HouseholdMemberWithRelations = {
  id: 'member-new',
  userId: INVITEE_ID,
  householdId: HOUSEHOLD_ID,
  collectionSharing: true,
  createdAt: NOW,
  updatedAt: NOW,
  user: { id: INVITEE_ID, username: 'sam', profile: { avatarUrl: null, displayName: 'Sam' } },
  // Not the role the invite offers: a member row that recorded the offered role would read the same.
  role: { role: { id: 'role-member', name: SystemRole.HouseholdMember } },
};

/** The household as the sender check reads it under the lock: its roster and its member invite policy. */
const AUTHORITY = {
  settings: { memberInvitePolicy: MemberInvitePolicy.NeedsApproval },
  members: [{ userId: INVITER_ID, role: { role: { name: SystemRole.HouseholdAdmin } } }],
};

describe('HouseholdInviteResponder', () => {
  let responder: HouseholdInviteResponder;
  let db: MockDatabaseService;
  let invites: jest.Mocked<
    Pick<
      InviteService,
      | 'findPartyScopeWithin'
      | 'findAcceptableWithin'
      | 'acceptWithin'
      | 'revokeWithin'
      | 'declineWithin'
      | 'withdrawWithin'
      | 'emit'
    >
  >;
  let members: jest.Mocked<Pick<HouseholdMemberService, 'addMemberWithin' | 'emitMemberAdmitted'>>;
  let abilities: jest.Mocked<Pick<AbilityService, 'userAbilityWithin'>>;
  let senderCan: jest.Mock<boolean, Parameters<UserAbilityCheck>>;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser'>>;
  let quotas: jest.Mocked<Pick<QuotaService, 'emitSoftOverages'>>;
  let offer: InviteOffer;
  let revocation: InviteRevocation;
  let acceptance: InviteAcceptance;
  let declination: InviteDeclination;
  let withdrawal: InviteWithdrawal;
  let admission: AddMemberResult;

  beforeEach(async () => {
    offer = {
      id: 'invite-1',
      inviterId: INVITER_ID,
      role: { id: 'role-admin', name: SystemRole.HouseholdAdmin },
      needsApproval: false,
    };
    revocation = {
      invite: partyView({ status: InviteStatus.Revoked }),
      event: { eventName: 'invite.revoked', subjectId: 'invite-1' } as never,
    };
    acceptance = { invite: partyView(), event: { eventName: 'invite.accepted' } as never };
    declination = {
      invite: partyView({ status: InviteStatus.Declined }),
      event: { eventName: 'invite.declined' } as never,
    };
    withdrawal = {
      invite: partyView({ status: InviteStatus.Withdrawn }),
      event: { eventName: 'invite.withdrawn' } as never,
    };
    admission = { member: NEW_MEMBER, admitted: true, softOverages: [OVERAGE] };

    invites = {
      findPartyScopeWithin: jest.fn().mockResolvedValue({ householdId: HOUSEHOLD_ID }),
      findAcceptableWithin: jest.fn().mockImplementation(() => Promise.resolve(offer)),
      acceptWithin: jest.fn().mockImplementation(() => Promise.resolve(acceptance)),
      revokeWithin: jest.fn().mockImplementation(() => Promise.resolve(revocation)),
      declineWithin: jest.fn().mockImplementation(() => Promise.resolve(declination)),
      withdrawWithin: jest.fn().mockImplementation(() => Promise.resolve(withdrawal)),
      emit: jest.fn(),
    };
    members = {
      addMemberWithin: jest.fn().mockImplementation(() => Promise.resolve(admission)),
      emitMemberAdmitted: jest.fn(),
    };
    senderCan = jest.fn().mockReturnValue(true);
    abilities = { userAbilityWithin: jest.fn().mockResolvedValue(senderCan) };
    permissions = { invalidateUser: jest.fn().mockResolvedValue(undefined) };
    quotas = { emitSoftOverages: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdInviteResponder,
        { provide: InviteService, useValue: invites },
        { provide: HouseholdMemberService, useValue: members },
        { provide: AbilityService, useValue: abilities },
        { provide: PermissionsService, useValue: permissions },
        { provide: QuotaService, useValue: quotas },
      ],
    });

    db = ctx.db;
    responder = ctx.module.get(HouseholdInviteResponder);

    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([{ id: HOUSEHOLD_ID }] as never);
    db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: true }));
    db.household.findUnique.mockResolvedValue(resolves(AUTHORITY));
  });

  it('answers for household invites, the type the party routes pick it by (#742)', () => {
    expect(responder.type).toBe(InviteType.Household);
  });

  describe('accept', () => {
    it('locks the household between the party-bound read of it and the accept, then admits as the inviter invited', async () => {
      // Recorded by hand: the mocked client and these mocks keep separate call
      // counters, so `invocationCallOrder` cannot compare them.
      const order: string[] = [];
      invites.findPartyScopeWithin.mockImplementation(async () => (order.push('read'), { householdId: HOUSEHOLD_ID }));
      db.$queryRaw.mockImplementation((async () => (order.push('lock'), [{ id: HOUSEHOLD_ID }])) as never);
      invites.findAcceptableWithin.mockImplementation(async () => (order.push('offer'), offer));
      senderCan.mockImplementation(() => (order.push('sender'), true));
      invites.acceptWithin.mockImplementation(async () => (order.push('accept'), acceptance));
      members.addMemberWithin.mockImplementation(async () => (order.push('admit'), admission));

      const { invite, member } = await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      const lookup = {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: ADDRESS,
        type: InviteType.Household,
      };
      expect(invites.findPartyScopeWithin).toHaveBeenCalledWith(db, lookup, InviteType.Household);
      expect(invites.findAcceptableWithin).toHaveBeenCalledWith(db, lookup);
      expect(invites.acceptWithin).toHaveBeenCalledWith(db, lookup);
      expect(members.addMemberWithin).toHaveBeenCalledWith(db, {
        householdId: HOUSEHOLD_ID,
        userId: INVITEE_ID,
        role: SystemRole.HouseholdAdmin,
        origin: HouseholdMembershipOrigin.InviteAccepted,
        addedById: INVITER_ID,
      });

      // The household row, then the invite, then the roster: the order a soft
      // delete takes the first two in. The sender is asked about under the
      // lock, and only once the lib would let the accept through (#747).
      expect(order).toEqual(['read', 'lock', 'offer', 'sender', 'accept', 'admit']);

      expect(invite).toBe(acceptance.invite);
      expect(member).toBe(admission.member);
    });

    it('vouches for no address that is unverified', async () => {
      db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: false }));

      await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(invites.acceptWithin).toHaveBeenCalledWith(db, {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: null,
        type: InviteType.Household,
      });
    });

    it('passes a token through as the target', async () => {
      await responder.accept({ token: 'live-accept-credential' }, INVITEE_ID);

      expect(invites.findPartyScopeWithin).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ target: { token: 'live-accept-credential' } }),
        InviteType.Household,
      );
    });

    it('evicts the new member’s ability cache, then announces the accept and the soft caps, after commit', async () => {
      let committed = false;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        committed = true;
        return result;
      }) as never);
      permissions.invalidateUser.mockImplementation(async () => expect(committed).toBe(true));

      await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(permissions.invalidateUser).toHaveBeenCalledWith(INVITEE_ID);
      expect(invites.emit).toHaveBeenCalledWith([acceptance.event]);
      expect(quotas.emitSoftOverages).toHaveBeenCalledWith([OVERAGE]);
      expect(permissions.invalidateUser.mock.invocationCallOrder[0]).toBeLessThan(
        invites.emit.mock.invocationCallOrder[0],
      );
    });

    it('answers 409 for someone already a member, and does nothing after the rollback', async () => {
      admission = { ...admission, admitted: false, softOverages: [] };

      await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.household.already_a_member' }),
      });

      expect(invites.emit).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
      expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
    });

    describe('the member-admitted domain event (#245)', () => {
      it('publishes the admitted member with origin InviteAccepted after the accepted invite', async () => {
        // The mocked client and these mocks keep separate call counters, so
        // the order is recorded by hand.
        const order: string[] = [];
        db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
          const result = await work(db);
          order.push('commit');

          return result;
        }) as never);
        permissions.invalidateUser.mockImplementation(async () => {
          order.push('evict');
        });
        invites.emit.mockImplementation(() => {
          order.push('invites');
        });
        members.emitMemberAdmitted.mockImplementation(() => {
          order.push('member admitted');
        });
        quotas.emitSoftOverages.mockImplementation(() => {
          order.push('soft caps');
        });

        await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

        expect(members.emitMemberAdmitted).toHaveBeenCalledTimes(1);
        // The row the admission wrote (its role is not the offered one), not
        // a rebuilt one.
        expect(members.emitMemberAdmitted.mock.calls[0][0]).toBe(NEW_MEMBER);
        expect(members.emitMemberAdmitted.mock.calls[0][1]).toBe(HouseholdMembershipOrigin.InviteAccepted);
        expect(members.emitMemberAdmitted.mock.calls[0][2]).toBeInstanceOf(Date);
        expect(order).toEqual(['commit', 'evict', 'invites', 'member admitted', 'soft caps']);
      });

      it('emits no member-admitted domain event when the invite is revoked at accept', async () => {
        // Its sender could no longer send it (#747): the revoke commits and
        // is announced, and nobody was admitted.
        senderCan.mockReturnValue(false);

        await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toMatchObject({ status: 409 });

        expect(invites.emit).toHaveBeenCalledWith([revocation.event]);
        expect(members.emitMemberAdmitted).not.toHaveBeenCalled();
      });

      it.each([
        [
          'at the admission',
          () => {
            admission = { ...admission, admitted: false, softOverages: [] };
          },
        ],
        [
          'on the roster the sender check reads',
          () => {
            senderCan.mockReturnValue(false);
            db.household.findUnique.mockResolvedValue(
              resolves({
                ...AUTHORITY,
                members: [
                  ...AUTHORITY.members,
                  { userId: INVITEE_ID, role: { role: { name: SystemRole.HouseholdMember } } },
                ],
              }),
            );
          },
        ],
      ])(
        'emits no member-admitted domain event when the invitee is already a member, found %s',
        async (_label, arrange) => {
          arrange();

          await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toMatchObject({
            status: 409,
            response: expect.objectContaining({ key: 'errors.household.already_a_member' }),
          });

          expect(members.emitMemberAdmitted).not.toHaveBeenCalled();
        },
      );
    });

    it('admits with the seam’s default when the invite offers no role', async () => {
      acceptance = { ...acceptance, invite: partyView({ role: null }) };

      await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(members.addMemberWithin).toHaveBeenCalledWith(db, expect.objectContaining({ role: undefined }));
    });

    it.each([SystemRole.HouseholdOwner, SystemRole.User])(
      'answers an invite offering %s as a server error, not the invitee’s',
      async (name) => {
        acceptance = { ...acceptance, invite: partyView({ role: { id: 'role-x', name } }) };

        const refusal = responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

        await expect(refusal).rejects.toThrow(`Invite invite-1 offers the role '${name}'`);
        await expect(refusal).rejects.not.toBeInstanceOf(ConflictException);
        expect(members.addMemberWithin).not.toHaveBeenCalled();
      },
    );

    it('admits nobody when the household lock finds it gone', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toThrow(NotFoundException);

      expect(invites.acceptWithin).not.toHaveBeenCalled();
      expect(members.addMemberWithin).not.toHaveBeenCalled();
    });

    describe('whether the sender could still send it (#747)', () => {
      /** The instance the sender's own invite grants are asked about, as the create builds it. */
      const subject = (needsApproval: boolean, role: SystemRole = SystemRole.HouseholdAdmin) => ({
        householdId: HOUSEHOLD_ID,
        needsApproval,
        role: { name: role },
        household: AUTHORITY,
      });

      it("asks the sender's own ability about the invite as one opened directly, with the household read under the lock", async () => {
        await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

        expect(db.household.findUnique).toHaveBeenCalledWith({
          where: { id: HOUSEHOLD_ID },
          select: {
            settings: { select: { memberInvitePolicy: true } },
            members: { select: { userId: true, role: { select: { role: { select: { name: true } } } } } },
          },
        });
        expect(abilities.userAbilityWithin).toHaveBeenCalledWith(db, INVITER_ID);
        expect(senderCan).toHaveBeenCalledTimes(1);
        expect(senderCan).toHaveBeenCalledWith(Action.create, ResourceType.Invite, subject(false));
      });

      it('asks about the role the admission grants when the invite offers none', async () => {
        offer = { ...offer, role: null };
        acceptance = { ...acceptance, invite: partyView({ role: null }) };

        await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

        expect(senderCan).toHaveBeenCalledWith(
          Action.create,
          ResourceType.Invite,
          subject(false, SystemRole.HouseholdMember),
        );
      });

      it('accepts an approved invite its sender could still send for approval', async () => {
        offer = { ...offer, needsApproval: true };
        senderCan.mockReturnValueOnce(false).mockReturnValueOnce(true);

        await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

        expect(senderCan).toHaveBeenNthCalledWith(2, Action.create, ResourceType.Invite, subject(true));
        // One graph for both questions.
        expect(abilities.userAbilityWithin).toHaveBeenCalledTimes(1);
        expect(invites.revokeWithin).not.toHaveBeenCalled();
        expect(members.addMemberWithin).toHaveBeenCalled();
      });

      it('revokes an unapproved invite its sender could now send only for approval', async () => {
        senderCan.mockReturnValueOnce(false).mockReturnValueOnce(true);

        await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toMatchObject({ status: 409 });

        // An invite that never waited for an approver isn't one now.
        expect(senderCan).toHaveBeenCalledTimes(1);
        expect(invites.revokeWithin).toHaveBeenCalled();
      });

      it('revokes the invite instead of accepting it, commits that, and answers 409 as for a revoked invite', async () => {
        senderCan.mockReturnValue(false);
        let committed = false;
        db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
          const result = await work(db);
          committed = true;
          return result;
        }) as never);
        invites.emit.mockImplementation(() => expect(committed).toBe(true));

        const refusal = await responder
          .accept({ token: 'live-accept-credential' }, INVITEE_ID)
          .catch((error: unknown) => error);

        // Nothing beyond the envelope and the `state`: no invite id, so the
        // invitee learns nothing of why (#1114).
        expect(refusal).toBeInstanceOf(CodedHttpException);
        expect((refusal as CodedHttpException).getStatus()).toBe(409);
        expect(Object.keys((refusal as CodedHttpException).getResponse() as object).sort()).toEqual(
          ['code', 'error', 'message', 'state', 'statusCode'].sort(),
        );
        expect((refusal as CodedHttpException).getResponse()).toMatchObject({
          code: 'INVITE_NOT_OUTSTANDING',
          state: InviteStatus.Revoked,
        });

        // By the id the read found, bound to the household, with the invitee as
        // the one revoking: the lib refuses only the inviter.
        expect(invites.revokeWithin).toHaveBeenCalledWith(db, {
          inviteId: 'invite-1',
          revokerId: INVITEE_ID,
          scope: { householdId: HOUSEHOLD_ID },
        });
        expect(invites.emit).toHaveBeenCalledWith([revocation.event]);
        expect(invites.acceptWithin).not.toHaveBeenCalled();
        expect(members.addMemberWithin).not.toHaveBeenCalled();
        expect(permissions.invalidateUser).not.toHaveBeenCalled();
        expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
      });

      it('asks nothing of the sender when the lib refuses the accept first', async () => {
        invites.findAcceptableWithin.mockRejectedValue(new ConflictException('awaiting approval'));

        await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toThrow(ConflictException);

        expect(abilities.userAbilityWithin).not.toHaveBeenCalled();
        expect(invites.revokeWithin).not.toHaveBeenCalled();
      });

      it('answers an existing member 409 already_a_member and revokes nothing, as the admission would', async () => {
        senderCan.mockReturnValue(false);
        db.household.findUnique.mockResolvedValue(
          resolves({
            ...AUTHORITY,
            members: [
              ...AUTHORITY.members,
              { userId: INVITEE_ID, role: { role: { name: SystemRole.HouseholdMember } } },
            ],
          }),
        );

        await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toMatchObject({
          status: 409,
          response: expect.objectContaining({ key: 'errors.household.already_a_member' }),
        });

        // Revoking would commit, and tell the inviter that an address invite
        // reached someone already in the household.
        expect(invites.revokeWithin).not.toHaveBeenCalled();
        expect(invites.emit).not.toHaveBeenCalled();
      });
    });
  });

  describe('decline', () => {
    it('declines a household invite of theirs, the lib binding the type in its own read, taking no lock', async () => {
      await expect(responder.decline({ inviteId: 'invite-1' }, INVITEE_ID)).resolves.toBe(declination.invite);

      expect(invites.declineWithin).toHaveBeenCalledWith(db, {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: ADDRESS,
        type: InviteType.Household,
      });
      // The transition's read binds the type, so no read goes ahead of it.
      expect(invites.findPartyScopeWithin).not.toHaveBeenCalled();
      // Only the invite row moves, so there is no household row to order it after.
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('vouches for no address that is unverified', async () => {
      db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: false }));

      await responder.decline({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(invites.declineWithin).toHaveBeenCalledWith(db, {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: null,
        type: InviteType.Household,
      });
    });

    it('passes a token through as the target', async () => {
      await responder.decline({ token: 'live-accept-credential' }, INVITEE_ID);

      expect(invites.declineWithin).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ target: { token: 'live-accept-credential' } }),
      );
    });

    it('announces the decline after commit', async () => {
      let committed = false;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        committed = true;
        return result;
      }) as never);
      invites.emit.mockImplementation(() => expect(committed).toBe(true));

      await responder.decline({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(invites.emit).toHaveBeenCalledWith([declination.event]);
    });

    it('announces nothing when the lib refuses, as it refuses an invite of another type', async () => {
      invites.declineWithin.mockRejectedValue(new NotFoundException());

      await expect(responder.decline({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toThrow(NotFoundException);

      expect(invites.emit).not.toHaveBeenCalled();
    });
  });

  describe('withdraw', () => {
    it('withdraws a household invite of theirs, the lib binding the type in its own read, taking no lock', async () => {
      await expect(responder.withdraw('invite-1', INVITER_ID)).resolves.toBe(withdrawal.invite);

      expect(invites.withdrawWithin).toHaveBeenCalledWith(db, {
        inviteId: 'invite-1',
        actingUserId: INVITER_ID,
        type: InviteType.Household,
      });
      expect(invites.findPartyScopeWithin).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('asks nothing of the inviter’s role in the household, nor of their address', async () => {
      await responder.withdraw('invite-1', INVITER_ID);

      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(db.householdMember.findUnique).not.toHaveBeenCalled();
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('announces the withdrawal after commit', async () => {
      let committed = false;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        committed = true;
        return result;
      }) as never);
      invites.emit.mockImplementation(() => expect(committed).toBe(true));

      await responder.withdraw('invite-1', INVITER_ID);

      expect(invites.emit).toHaveBeenCalledWith([withdrawal.event]);
    });

    it('announces nothing when the lib refuses, as it refuses an invite of another type', async () => {
      invites.withdrawWithin.mockRejectedValue(new NotFoundException());

      await expect(responder.withdraw('invite-1', INVITER_ID)).rejects.toThrow(NotFoundException);

      expect(invites.emit).not.toHaveBeenCalled();
    });
  });
});
