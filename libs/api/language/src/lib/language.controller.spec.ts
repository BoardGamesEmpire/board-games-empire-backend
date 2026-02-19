import { Test } from '@nestjs/testing';
import { LanguageController } from './language.controller';
import { LanguageService } from './language.service';

describe('LanguageController', () => {
  let controller: LanguageController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [LanguageService],
      controllers: [LanguageController],
    }).compile();

    controller = module.get(LanguageController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
