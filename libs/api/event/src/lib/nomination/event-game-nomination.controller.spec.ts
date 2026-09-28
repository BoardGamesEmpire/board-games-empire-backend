import { ResourceType, type EventGameNomination } from '@bge/database';
import { ListScopeNotComposedError } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { EventGameNominationController } from './event-game-nomination.controller';
import { EventGameNominationService } from './event-game-nomination.service';

const PAGINATION = paginationQuery({ limit: 10 });

describe('EventGameNominationController', () => {
  let controller: EventGameNominationController;
  let service: jest.Mocked<Pick<EventGameNominationService, 'getNominations'>>;

  beforeEach(() => {
    service = {
      getNominations: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    };
    controller = new EventGameNominationController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getNominations', () => {
    it('delegates with the event and the paging', async () => {
      await firstValueFrom(controller.getNominations('event-1', PAGINATION));

      expect(service.getNominations).toHaveBeenCalledWith('event-1', PAGINATION);
    });

    // #372: the echoed paging describes the query the controller was handed,
    // so a deep page has to report itself as one.
    it('wraps the rows in the paginated envelope, echoing the requested page', async () => {
      const nominations = [{ id: 'nom-1' }] as EventGameNomination[];
      service.getNominations.mockResolvedValue({ rows: nominations, total: 31 });

      const response = await firstValueFrom(
        controller.getNominations('event-1', paginationQuery({ page: 2, limit: 10 })),
      );

      expect(response).toEqual({
        nominations,
        pagination: { page: 2, limit: 10, total: 31, totalPages: 4, hasMore: true },
      });
    });

    // The service composes the `EventGameNomination` scope; the envelope is
    // where the guard checks for it, under the resource type the handler
    // passes. Built inside a request with nothing composed, it must fail. A
    // handler passing a type still in `PENDING_SCOPE_SWEEP` would pass here
    // instead, which switches the guard off for that route without a sound.
    //
    // The failure has to name `EventGameNomination` itself. The three event
    // lists left the sweep together, so a handler passing a sibling's type
    // fails here too, and in a real request answers 500.
    it('builds its envelope under the EventGameNomination scope guard', async () => {
      const envelope = ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.getNominations('event-1', PAGINATION)),
      );

      await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
      await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.EventGameNomination}'`);
    });
  });
});
