import { Action, ResourceType } from '@bge/database';
import { AbilityService, CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { createMockAbilityService, createTestingModuleWithDb, MOCK_ACTING_USER_ID } from '@bge/testing';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

describe('SystemSettingsController', () => {
  let controller: SystemSettingsController;
  const sendTestMail = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    sendTestMail.mockClear();
    const { module } = await createTestingModuleWithDb({
      providers: [
        { provide: SystemSettingsService, useValue: { sendTestMail } },
        { provide: AbilityService, useValue: createMockAbilityService() },
      ],
      controllers: [SystemSettingsController],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(SystemSettingsController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });

  it("queues the test email for the acting admin's own address and answers { queued: true } (#654)", async () => {
    await expect(controller.mailTest()).resolves.toEqual({ queued: true });

    expect(sendTestMail).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });
});

describe('SystemSettingsController policies', () => {
  // The subject is SystemSetting, the model the row lives in, so the catalog's
  // update:system_setting grant is the one the guard consults (#441).
  it.each([
    ['getSystemSettings', Action.read],
    ['updateSystemSettings', Action.update],
    ['mailTest', Action.update],
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
