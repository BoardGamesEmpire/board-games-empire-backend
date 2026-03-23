import { createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { LanguageController } from './language.controller';
import { LanguageService } from './language.service';

describe('LanguageController', () => {
  let controller: LanguageController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      overrideGuards: [AuthGuard],
      providers: [LanguageService],
      controllers: [LanguageController],
    });

    controller = module.get(LanguageController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
