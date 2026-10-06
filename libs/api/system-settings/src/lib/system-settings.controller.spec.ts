import { Action, ResourceType } from '@bge/database';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigService } from '@nestjs/config';
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
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(SystemSettingsController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});

describe('SystemSettingsController policies', () => {
  // The subject is SystemSetting, the model the row lives in, so the catalog's
  // update:system_setting grant is the one the guard consults (#441).
  it.each([
    ['getSystemSettings', Action.read],
    ['updateSystemSettings', Action.update],
  ] as const)('%s requires %s on SystemSetting', (method, action) => {
    const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, SystemSettingsController.prototype[method]) as Array<
      (ability: AppAbility) => boolean
    >;
    const can = jest.fn().mockReturnValue(true);

    expect(handlers).toHaveLength(1);
    handlers[0]({ can } as unknown as AppAbility);

    expect(can).toHaveBeenCalledTimes(1);
    expect(can).toHaveBeenCalledWith(action, ResourceType.SystemSetting);
  });
});
