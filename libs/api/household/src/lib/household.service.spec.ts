import { Test } from '@nestjs/testing';
import { HouseholdService } from './household.service';

describe('HouseholdService', () => {
  let service: HouseholdService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [HouseholdService],
    }).compile();

    service = module.get(HouseholdService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
