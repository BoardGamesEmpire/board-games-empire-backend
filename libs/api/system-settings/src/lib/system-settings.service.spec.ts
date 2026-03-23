import { createTestingModuleWithDb } from '@bge/testing';
import { SystemSettingsService } from './system-settings.service';

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [SystemSettingsService],
    });

    service = module.get(SystemSettingsService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
