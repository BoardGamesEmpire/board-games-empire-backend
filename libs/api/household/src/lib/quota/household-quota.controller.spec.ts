import { Action, QuotaScope, ResourceType, type DatabaseService } from '@bge/database';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AbilityService, type AppAbility } from '@bge/permissions';
import { QuotaService, type QuotaView } from '@bge/quota';
import { NotFoundException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { HouseholdLivenessGuard } from '../guards/household-liveness.guard';
import { HouseholdQuotaController } from './household-quota.controller';

const VIEW = {
  id: 'q-1',
  scope: QuotaScope.Household,
  scopeId: 'hh-1',
  householdId: 'hh-1',
  resource: 'household_member_count',
  limit: '8',
  softOverage: false,
  enforced: true,
} as unknown as QuotaView;

describe('HouseholdQuotaController', () => {
  let controller: HouseholdQuotaController;
  let quotas: jest.Mocked<Pick<QuotaService, 'getHouseholdQuotas'>>;

  beforeEach(() => {
    quotas = { getHouseholdQuotas: jest.fn().mockResolvedValue([VIEW]) };
    controller = new HouseholdQuotaController(quotas as unknown as QuotaService);
  });

  afterEach(() => jest.clearAllMocks());

  // A bare array, like `GET /quotas`: a household has at most one row per
  // resource for itself and one per member, so there is nothing to page.
  it("list forwards the path household and returns its quotas under 'quotas'", async () => {
    const result = await firstValueFrom(controller.list('hh-1'));

    expect(quotas.getHouseholdQuotas).toHaveBeenCalledWith('hh-1');
    expect(result).toEqual({ quotas: [VIEW] });
  });

  it('binds GET under /households/:householdId/quotas', () => {
    expect(Reflect.getMetadata('path', HouseholdQuotaController)).toBe('households/:householdId/quotas');
    expect(Reflect.getMetadata('method', HouseholdQuotaController.prototype.list)).toBe(RequestMethod.GET);
  });

  // Read from the decorators, not the instance: this spec constructs the
  // controller directly, so a deleted @CheckPolicies would be invisible to the
  // delegation test above.
  it('gates on read:Quota', () => {
    const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, HouseholdQuotaController.prototype.list) as
      | Array<(ability: AppAbility) => boolean>
      | undefined;
    expect(handlers).toHaveLength(1);

    const gate = jest.fn().mockReturnValue(true);
    handlers?.[0]({ can: gate } as unknown as AppAbility);

    expect(gate).toHaveBeenCalledWith(Action.read, ResourceType.Quota);
  });

  /**
   * The route names a household, so a missing or soft-deleted one answers 404
   * here as on the other household routes (#299), through the same guard.
   */
  describe('household liveness', () => {
    it('runs the household liveness guard before PoliciesGuard', () => {
      // Order is the mechanism: after PoliciesGuard, the 403 it answers an
      // actor whose deleted household took its only rule would still win.
      expect(Reflect.getMetadata('__guards__', HouseholdQuotaController)).toEqual([
        HouseholdLivenessGuard,
        PoliciesGuard,
      ]);
    });

    it('probes the route household, and answers 404 when it is gone', async () => {
      const count = jest.fn().mockResolvedValue(0);
      const guard = new HouseholdLivenessGuard(
        new Reflector(),
        { household: { count } } as unknown as DatabaseService,
        { getCurrentAbilities: () => [{ can: () => true }] } as unknown as AbilityService,
      );
      const context = {
        getClass: () => HouseholdQuotaController,
        getHandler: () => HouseholdQuotaController.prototype.list,
        switchToHttp: () => ({ getRequest: () => ({ params: { householdId: 'hh-gone' } }) }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException);
      expect(count).toHaveBeenCalledWith({ where: { id: 'hh-gone', deletedAt: null } });
    });
  });
});
