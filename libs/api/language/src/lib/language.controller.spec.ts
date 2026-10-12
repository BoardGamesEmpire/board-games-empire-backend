import { AbilityService } from '@bge/permissions';
import { CACHE_RESPONSE_KEY } from '@bge/shared';
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

  // #530: the response cache's first routes. The catalogue is the same for
  // every caller and seldom changes, so a read up to the TTL old is harmless.
  it.each(['getLanguages', 'getLanguageById'] as const)('opts %s into the response cache', (method) => {
    expect(Reflect.getMetadata(CACHE_RESPONSE_KEY, LanguageController.prototype[method])).toBe(true);
  });
});
