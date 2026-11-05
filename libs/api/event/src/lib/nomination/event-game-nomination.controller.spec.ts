import { NominationStatus, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { ListScopeNotComposedError } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { EventGameNominationController } from './event-game-nomination.controller';
import { EventGameNominationService, type NominationDetail } from './event-game-nomination.service';

const PAGINATION = paginationQuery({ limit: 10 });

describe('EventGameNominationController', () => {
  let controller: EventGameNominationController;
  let service: jest.Mocked<Pick<EventGameNominationService, 'getNominations' | 'resolveNomination'>>;

  beforeEach(() => {
    service = {
      getNominations: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      resolveNomination: jest.fn(),
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
      const nominations = [{ id: 'nom-1' }] as NominationDetail[];
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
    // handler declaring `Unscoped` would pass here instead, which switches the
    // guard off for that route without a sound.
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

  // #798: the message said "Nomination resolved: QuorumNotMet", a status's
  // code name. Each outcome gets a message of its own, in plain words.
  describe('resolve', () => {
    it.each([
      { status: NominationStatus.Passed, key: 'success.nomination.passed' as const },
      { status: NominationStatus.Failed, key: 'success.nomination.failed' as const },
      { status: NominationStatus.QuorumNotMet, key: 'success.nomination.quorum_not_met' as const },
    ])('says a $status outcome in words of its own', async ({ status, key }) => {
      const nomination = { id: 'nom-1' } as NominationDetail;
      const resolution = {
        status,
        tally: { forCount: 0, againstCount: 0, interestedCount: 0, totalVotes: 0 },
        quorumMet: status !== NominationStatus.QuorumNotMet,
        thresholdMet: status === NominationStatus.Passed,
        eligibleVoterCount: 0,
      };
      service.resolveNomination.mockResolvedValue({ nomination, resolution });

      const response = await firstValueFrom(controller.resolve('event-1', 'nom-1'));

      expect(service.resolveNomination).toHaveBeenCalledWith('event-1', 'nom-1');
      expect(response).toEqual({ message: t(key), nomination, resolution });
    });
  });
});
