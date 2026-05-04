import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

describe('SystemSettingsController', () => {
  let controller: SystemSettingsController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [
        SystemSettingsService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn(), getOrThrow: jest.fn() },
        },
      ],
      controllers: [SystemSettingsController],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(SystemSettingsController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
