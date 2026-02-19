import { Test } from '@nestjs/testing';
import { SystemSettingsController } from './system-settings.controller';

describe('SystemSettingsController', () => {
  let controller: SystemSettingsController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [],
      controllers: [SystemSettingsController],
    }).compile();

    controller = module.get(SystemSettingsController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
