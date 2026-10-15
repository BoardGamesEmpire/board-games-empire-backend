import { paginationQuery } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { PartyInviteController } from './party-invite.controller';
import type { PartyInviteService, ReceivedInviteView } from './party-invite.service';

const RECEIVED = { id: 'invite-2', household: { id: 'hh-1', name: 'Home' } } as ReceivedInviteView;

describe('PartyInviteController (delegation)', () => {
  let controller: PartyInviteController;
  let service: jest.Mocked<Pick<PartyInviteService, 'listReceived'>>;

  beforeEach(() => {
    service = { listReceived: jest.fn().mockResolvedValue({ rows: [RECEIVED], total: 1 }) };
    controller = new PartyInviteController(service as never);
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
