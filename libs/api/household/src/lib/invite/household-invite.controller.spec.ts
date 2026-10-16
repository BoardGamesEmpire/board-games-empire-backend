import { InviteStatus } from '@bge/database';
import type { InviteContextView, InvitePartyView } from '@bge/invites';
import { paginationQuery } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import type { ListHouseholdInvitesQueryDto } from '../dto';
import { HouseholdInviteController } from './household-invite.controller';
import type { HouseholdInviteService } from './household-invite.service';

const INVITE = { id: 'invite-1', status: InviteStatus.Pending } as InvitePartyView;
const REVOKED = { id: 'invite-1', status: InviteStatus.Revoked } as InviteContextView;

describe('HouseholdInviteController (delegation)', () => {
  let controller: HouseholdInviteController;
  let service: jest.Mocked<Pick<HouseholdInviteService, 'createInvite' | 'listInvites' | 'revokeInvite'>>;

  beforeEach(() => {
    service = {
      createInvite: jest.fn().mockResolvedValue(INVITE),
      listInvites: jest.fn().mockResolvedValue({ rows: [INVITE], total: 1 }),
      revokeInvite: jest.fn().mockResolvedValue(REVOKED),
    };
    controller = new HouseholdInviteController(service as never);
  });

  it('createInvite forwards the household and the DTO, wrapping the invite with a success message', async () => {
    const dto = { inviteeId: 'user-2' };

    const result = await firstValueFrom(controller.createInvite('hh-1', dto));

    expect(service.createInvite).toHaveBeenCalledWith('hh-1', dto);
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.household.invite_created' }),
      invite: INVITE,
    });
  });

  it('listInvites forwards the household and the query, wrapping the page in the envelope', async () => {
    const query = Object.assign(paginationQuery({ limit: 10 }), {
      status: InviteStatus.Declined,
    }) as ListHouseholdInvitesQueryDto;

    const result = await firstValueFrom(controller.listInvites('hh-1', query));

    expect(service.listInvites).toHaveBeenCalledWith('hh-1', query);
    expect(result).toEqual({
      invites: [INVITE],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('revokeInvite forwards the household and the invite, wrapping the invite with a success message', async () => {
    const result = await firstValueFrom(controller.revokeInvite('hh-1', 'invite-1'));

    expect(service.revokeInvite).toHaveBeenCalledWith('hh-1', 'invite-1');
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.household.invite_revoked' }),
      invite: REVOKED,
    });
  });
});
