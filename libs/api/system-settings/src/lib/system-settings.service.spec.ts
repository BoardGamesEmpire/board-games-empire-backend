import { Test } from '@nestjs/testing';
import { SystemSettingsService } from './system-settings.service';

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [SystemSettingsService],
    }).compile();

    service = module.get(SystemSettingsService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
