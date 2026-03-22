import { createTestingModuleWithDb } from '@bge/testing';
import { LanguageService } from './language.service';

describe('LanguageService', () => {
  let service: LanguageService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [LanguageService],
    });

    service = module.get(LanguageService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
