import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

describe('SystemSettingsController', () => {
  let controller: SystemSettingsController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [SystemSettingsService],
      controllers: [SystemSettingsController],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(SystemSettingsController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
