import { InviteStatus } from '@bge/database';
import type { InvitePartyView } from '@bge/invites';
import { paginationQuery } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import type { HouseholdMemberWithRelations } from '../member/household-member.service';
import { PartyInviteController } from './party-invite.controller';
import type { PartyInviteService, ReceivedInviteView } from './party-invite.service';

const INVITE = { id: 'invite-1', status: InviteStatus.Accepted } as InvitePartyView;
const RECEIVED = { id: 'invite-2', household: { id: 'hh-1', name: 'Home' } } as ReceivedInviteView;
const MEMBER = { id: 'member-1', householdId: 'hh-1' } as HouseholdMemberWithRelations;

describe('PartyInviteController (delegation)', () => {
  let controller: PartyInviteController;
  let service: jest.Mocked<Pick<PartyInviteService, 'accept' | 'listReceived'>>;

  beforeEach(() => {
    service = {
      accept: jest.fn().mockResolvedValue({ invite: INVITE, member: MEMBER }),
      listReceived: jest.fn().mockResolvedValue({ rows: [RECEIVED], total: 1 }),
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
});
