import { InviteStatus } from '@bge/database';
import type { InviteContextView, InvitePartyView } from '@bge/invites';
import { paginationQuery } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import type { ListEventInvitesQueryDto } from './dto/list-event-invites-query.dto';
import { EventInviteController } from './event-invite.controller';
import type { EventInviteService } from './event-invite.service';

const INVITE = { id: 'invite-1', status: InviteStatus.Pending } as InvitePartyView;
const REVOKED = { id: 'invite-1', status: InviteStatus.Revoked } as InviteContextView;

describe('EventInviteController (delegation, #742)', () => {
  let controller: EventInviteController;
  let service: jest.Mocked<Pick<EventInviteService, 'createInvite' | 'listInvites' | 'revokeInvite'>>;

  beforeEach(() => {
    service = {
      createInvite: jest.fn().mockResolvedValue(INVITE),
      listInvites: jest.fn().mockResolvedValue({ rows: [REVOKED], total: 1 }),
      revokeInvite: jest.fn().mockResolvedValue(REVOKED),
    };
    controller = new EventInviteController(service as never);
  });

  it('createInvite forwards the event and the DTO, wrapping the invite with a success message', async () => {
    const dto = { userId: 'user-2' };

    const result = await firstValueFrom(controller.createInvite('ev-1', dto));

    expect(service.createInvite).toHaveBeenCalledWith('ev-1', dto);
    expect(result).toEqual({ message: expect.objectContaining({ key: 'success.event.invite_sent' }), invite: INVITE });
  });

  it('listInvites forwards the event and the query, wrapping the page in the envelope', async () => {
    const query = Object.assign(paginationQuery({ limit: 10 }), {
      status: InviteStatus.Revoked,
    }) as ListEventInvitesQueryDto;

    const result = await firstValueFrom(controller.listInvites('ev-1', query));

    expect(service.listInvites).toHaveBeenCalledWith('ev-1', query);
    expect(result).toEqual({
      invites: [REVOKED],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('revokeInvite forwards the event and the invite, wrapping the invite with a success message', async () => {
    const result = await firstValueFrom(controller.revokeInvite('ev-1', 'invite-1'));

    expect(service.revokeInvite).toHaveBeenCalledWith('ev-1', 'invite-1');
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.event.invite_revoked' }),
      invite: REVOKED,
    });
  });
});
