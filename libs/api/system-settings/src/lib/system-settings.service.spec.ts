import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from './system-settings.service';

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [
        SystemSettingsService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn(), getOrThrow: jest.fn() },
        },
      ],
    });

    service = module.get(SystemSettingsService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
