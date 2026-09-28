import { Action, ResourceType, type DatabaseService } from '@bge/database';
import { PoliciesGuard, type AbilityService, type AppAbility } from '@bge/permissions';
import { Controller, NotFoundException, type ExecutionContext, type Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Http } from '@status/codes';
import 'reflect-metadata';
import { HouseholdController } from '../household.controller';
import { HouseholdMemberController } from '../member/household-member.controller';
import { AllowsDeletedHousehold, HouseholdLivenessGuard, HouseholdPathParam } from './household-liveness.guard';

/**
 * The guard against the real controllers' handlers and metadata, so what is
 * pinned is the wiring a request actually meets, not a copy of it.
 */
describe('HouseholdLivenessGuard', () => {
  let count: jest.Mock;
  let abilities: jest.Mock;
  let guard: HouseholdLivenessGuard;

  /** An ability that answers `can` with `reads` for any question, and records the question. */
  const ability = (reads: boolean) => ({ can: jest.fn().mockReturnValue(reads) }) as unknown as AppAbility;

  beforeEach(() => {
    count = jest.fn().mockResolvedValue(1);
    // A user session: one ability, and it reads households.
    abilities = jest.fn().mockReturnValue([ability(true)]);
    guard = new HouseholdLivenessGuard(
      new Reflector(),
      { household: { count } } as unknown as DatabaseService,
      { getCurrentAbilities: abilities } as unknown as AbilityService,
    );
  });

  const contextFor = (
    controller: Type,
    handler: (...args: never[]) => unknown,
    params: Record<string, string>,
  ): ExecutionContext =>
    ({
      getClass: () => controller,
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ params }) }),
    }) as unknown as ExecutionContext;

  it('lets a live household through, probing it with the soft-delete filter', async () => {
    await expect(
      guard.canActivate(contextFor(HouseholdController, HouseholdController.prototype.update, { id: 'hh-1' })),
    ).resolves.toBe(true);

    expect(count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null } });
  });

  it('answers 404 for a household that is missing or soft-deleted, before any policy runs (#299)', async () => {
    // The point of running first. PoliciesGuard can only ask whether the actor
    // holds ANY rule for the action, and an owner whose only household was
    // deleted holds none, so it answered 403 where an owner of a second
    // household reached the service and got 404.
    count.mockResolvedValue(0);

    await expect(
      guard.canActivate(contextFor(HouseholdController, HouseholdController.prototype.delete, { id: 'hh-gone' })),
    ).rejects.toMatchObject({
      status: Http.NotFound,
      response: expect.objectContaining({ key: 'errors.household.not_found' }),
    });
  });

  it('reads the member routes’ household from the parameter that controller names', async () => {
    await guard.canActivate(
      contextFor(HouseholdMemberController, HouseholdMemberController.prototype.removeMember, {
        householdId: 'hh-1',
        memberId: 'member-1',
      }),
    );

    expect(count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null } });
  });

  it('passes a route with no household in its path without probing', async () => {
    // List and create: nothing to be live or not.
    await expect(
      guard.canActivate(contextFor(HouseholdController, HouseholdController.prototype.getHouseholdsForUser, {})),
    ).resolves.toBe(true);

    expect(count).not.toHaveBeenCalled();
  });

  it('asks whether the actor reads households, the question GET /households/:id already answers', async () => {
    const reader = ability(true);
    abilities.mockReturnValue([reader]);

    await guard.canActivate(contextFor(HouseholdController, HouseholdController.prototype.update, { id: 'hh-1' }));

    expect(reader.can).toHaveBeenCalledWith(Action.read, ResourceType.Household);
  });

  it('leaves an API key scoped away from households to PoliciesGuard, so it learns nothing new', async () => {
    // Owner ability AND key ability, as PoliciesGuard sees them. The key may
    // not read households, so before this guard it got 403 for every id. A
    // 404 for a missing one would tell it which ids exist.
    abilities.mockReturnValue([ability(true), ability(false)]);
    count.mockResolvedValue(0);

    await expect(
      guard.canActivate(contextFor(HouseholdController, HouseholdController.prototype.update, { id: 'hh-gone' })),
    ).resolves.toBe(true);

    expect(count).not.toHaveBeenCalled();
  });

  it('leaves an actor with no abilities to PoliciesGuard, rather than passing it vacuously', async () => {
    abilities.mockReturnValue([]);

    await expect(
      guard.canActivate(contextFor(HouseholdController, HouseholdController.prototype.update, { id: 'hh-gone' })),
    ).resolves.toBe(true);

    expect(count).not.toHaveBeenCalled();
  });

  it('passes a route that opts out, without probing', async () => {
    @HouseholdPathParam('id')
    @Controller('opt-out')
    class OptOutController {
      @AllowsDeletedHousehold()
      handle(): void {
        return undefined;
      }
    }

    await expect(
      guard.canActivate(contextFor(OptOutController, OptOutController.prototype.handle, { id: 'hh-gone' })),
    ).resolves.toBe(true);

    expect(count).not.toHaveBeenCalled();
  });

  it('refuses to guess when its controller never named the parameter', async () => {
    // A programmer error, and loud on purpose: guessing `id` would probe the
    // wrong value on a controller whose `:id` is not a household.
    @Controller('unnamed')
    class UnnamedController {
      handle(): void {
        return undefined;
      }
    }

    await expect(
      guard.canActivate(contextFor(UnnamedController, UnnamedController.prototype.handle, { id: 'hh-1' })),
    ).rejects.toThrow(/HouseholdPathParam/);
    await expect(
      guard.canActivate(contextFor(UnnamedController, UnnamedController.prototype.handle, { id: 'hh-1' })),
    ).rejects.not.toBeInstanceOf(NotFoundException);
  });

  it.each([HouseholdController, HouseholdMemberController])('runs before PoliciesGuard on %p', (controller) => {
    // Order is the whole mechanism: after PoliciesGuard, the 403 it answers
    // for an actor with no rule would still win.
    expect(Reflect.getMetadata('__guards__', controller)).toEqual([HouseholdLivenessGuard, PoliciesGuard]);
  });
});
