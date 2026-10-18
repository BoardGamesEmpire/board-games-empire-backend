import { InviteStatus } from '@bge/database';
import type { InvitePartyView } from '@bge/invites';
import { paginationQuery } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import type { HouseholdMemberWithRelations } from '../member/household-member.service';
import { PartyInviteController } from './party-invite.controller';
import type { ListedPartyInviteView, PartyInviteService } from './party-invite.service';

const INVITE = { id: 'invite-1', status: InviteStatus.Accepted } as InvitePartyView;
const RECEIVED = { id: 'invite-2', household: { id: 'hh-1', name: 'Home' } } as ListedPartyInviteView;
const SENT = { id: 'invite-3', household: { id: 'hh-1', name: 'Home' } } as ListedPartyInviteView;
const MEMBER = { id: 'member-1', householdId: 'hh-1' } as HouseholdMemberWithRelations;
const DECLINED = { id: 'invite-1', status: InviteStatus.Declined } as InvitePartyView;
const WITHDRAWN = { id: 'invite-1', status: InviteStatus.Withdrawn } as InvitePartyView;

describe('PartyInviteController (delegation)', () => {
  let controller: PartyInviteController;
  let service: jest.Mocked<Pick<PartyInviteService, 'accept' | 'listReceived' | 'listSent' | 'decline' | 'withdraw'>>;

  beforeEach(() => {
    service = {
      accept: jest.fn().mockResolvedValue({ invite: INVITE, member: MEMBER }),
      listReceived: jest.fn().mockResolvedValue({ rows: [RECEIVED], total: 1 }),
      listSent: jest.fn().mockResolvedValue({ rows: [SENT], total: 1 }),
      decline: jest.fn().mockResolvedValue(DECLINED),
      withdraw: jest.fn().mockResolvedValue(WITHDRAWN),
    };
    controller = new PartyInviteController(service as never);
  });

  it('accept forwards the id as the target, answering the invite and the membership', async () => {
    const result = await firstValueFrom(controller.accept('invite-1'));

    expect(service.accept).toHaveBeenCalledWith({ inviteId: 'invite-1' });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.household.invite_accepted' }),
      invite: INVITE,
      member: MEMBER,
    });
  });

  it('acceptByToken forwards the token from the body as the target', async () => {
    const result = await firstValueFrom(controller.acceptByToken({ token: 'live-accept-credential' }));

    expect(service.accept).toHaveBeenCalledWith({ token: 'live-accept-credential' });
    expect(result).toMatchObject({ invite: INVITE, member: MEMBER });
  });

  it('listReceived forwards the query, wrapping the page in the envelope', async () => {
    const query = paginationQuery({ limit: 10 });

    const result = await firstValueFrom(controller.listReceived(query));

    expect(service.listReceived).toHaveBeenCalledWith(query);
    expect(result).toEqual({
      invites: [RECEIVED],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('listSent forwards the query, wrapping the page in the envelope', async () => {
    const query = Object.assign(paginationQuery({ limit: 10 }), { status: InviteStatus.Expired });

    const result = await firstValueFrom(controller.listSent(query));

    expect(service.listSent).toHaveBeenCalledWith(query);
    expect(result).toEqual({
      invites: [SENT],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('decline forwards the id as the target, answering the invite', async () => {
    const result = await firstValueFrom(controller.decline('invite-1'));

    expect(service.decline).toHaveBeenCalledWith({ inviteId: 'invite-1' });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.household.invite_declined' }),
      invite: DECLINED,
    });
  });

  it('declineByToken forwards the token from the body as the target', async () => {
    const result = await firstValueFrom(controller.declineByToken({ token: 'live-accept-credential' }));

    expect(service.decline).toHaveBeenCalledWith({ token: 'live-accept-credential' });
    expect(result).toMatchObject({ invite: DECLINED });
  });

  it('withdraw forwards the id, answering the invite', async () => {
    const result = await firstValueFrom(controller.withdraw('invite-1'));

    expect(service.withdraw).toHaveBeenCalledWith('invite-1');
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.household.invite_withdrawn' }),
      invite: WITHDRAWN,
    });
  });
});
