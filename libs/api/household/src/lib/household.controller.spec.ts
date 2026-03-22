import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';

describe('HouseholdController', () => {
  let controller: HouseholdController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      overrideGuards: [AuthGuard, PoliciesGuard],
      providers: [HouseholdService],
      controllers: [HouseholdController],
    });

    controller = module.get(HouseholdController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
