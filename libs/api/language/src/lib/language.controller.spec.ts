import { AbilityService } from '@bge/permissions';
import { createMockAbilityService, createTestingModuleWithDb } from '@bge/testing';
import { LanguageController } from './language.controller';
import { LanguageService } from './language.service';

describe('LanguageController', () => {
  let controller: LanguageController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [LanguageService, { provide: AbilityService, useValue: createMockAbilityService() }],
      controllers: [LanguageController],
    });

    controller = module.get(LanguageController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
