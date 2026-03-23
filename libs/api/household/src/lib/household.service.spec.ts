import { createTestingModuleWithDb } from '@bge/testing';
import { HouseholdService } from './household.service';

describe('HouseholdService', () => {
  let service: HouseholdService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [HouseholdService],
    });

    service = module.get(HouseholdService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
