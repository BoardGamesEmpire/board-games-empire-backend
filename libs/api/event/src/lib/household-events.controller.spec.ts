import { EventStatus, ResourceType, type DatabaseService } from '@bge/database';
import { HouseholdLivenessGuard } from '@bge/household';
import { PoliciesGuard, type AbilityService } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { makeEvent, paginationQuery } from '@bge/testing';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import type { EventService } from './event.service';
import { HouseholdEventsController } from './household-events.controller';

describe('HouseholdEventsController (#506)', () => {
  let service: jest.Mocked<Pick<EventService, 'getHouseholdEvents'>>;
  let controller: HouseholdEventsController;

  beforeEach(() => {
    service = { getHouseholdEvents: jest.fn() };
    controller = new HouseholdEventsController(service as unknown as EventService);
  });

  // The order is the mechanism: after PoliciesGuard, its 403 for an actor with
  // no rule would answer before a dead household's 404.
  it('runs the household liveness guard before PoliciesGuard', () => {
    expect(Reflect.getMetadata('__guards__', HouseholdEventsController)).toEqual([
      HouseholdLivenessGuard,
      PoliciesGuard,
    ]);
  });

  // `@bge/household` doesn't export the metadata key, so this runs the guard
  // over the class: a wrong parameter name would read `undefined` and pass.
  it('probes the household the route names, and answers 404 when it is gone', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const guard = new HouseholdLivenessGuard(
      new Reflector(),
      { household: { count } } as unknown as DatabaseService,
      { getCurrentAbilities: () => [{ can: () => true }] } as unknown as AbilityService,
    );
    const context = {
      getClass: () => HouseholdEventsController,
      getHandler: () => HouseholdEventsController.prototype.getHouseholdEvents,
      switchToHttp: () => ({ getRequest: () => ({ params: { householdId: 'hh-gone' } }) }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
    expect(count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'hh-gone' }) }));
  });

  it('delegates to the service and wraps the rows in the paginated envelope', async () => {
    const row = { ...makeEvent({ id: 'event-1' }), status: EventStatus.Scheduled, attendance: null };
    service.getHouseholdEvents.mockResolvedValue({ rows: [row], total: 1 });
    const query = paginationQuery({ limit: 10 });

    const result = await firstValueFrom(controller.getHouseholdEvents('household-1', query));

    expect(service.getHouseholdEvents).toHaveBeenCalledWith('household-1', query);
    expect(result).toEqual({
      events: [row],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  // The service composes the `Event` scope, so the envelope must name `Event`
  // too, or the guard can't tell the read was composed.
  it('builds its envelope under the Event scope guard', async () => {
    service.getHouseholdEvents.mockResolvedValue({ rows: [], total: 0 });

    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.getHouseholdEvents('household-1', paginationQuery({ limit: 10 }))),
    );

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.Event}'`);
  });
});
