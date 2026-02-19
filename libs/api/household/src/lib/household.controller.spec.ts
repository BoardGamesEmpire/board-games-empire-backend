import { Test } from '@nestjs/testing';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';

describe('HouseholdController', () => {
  let controller: HouseholdController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [HouseholdService],
      controllers: [HouseholdController],
    }).compile();

    controller = module.get(HouseholdController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
