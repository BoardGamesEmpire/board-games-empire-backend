import { AbilityService } from '@bge/permissions';
import { createMockAbilityService, createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { LanguageController } from './language.controller';
import { LanguageService } from './language.service';

describe('LanguageController', () => {
  let controller: LanguageController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      overrideGuards: [AuthGuard],
      providers: [LanguageService, { provide: AbilityService, useValue: createMockAbilityService() }],
      controllers: [LanguageController],
    });

    controller = module.get(LanguageController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
