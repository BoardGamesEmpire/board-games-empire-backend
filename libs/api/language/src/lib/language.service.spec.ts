import { Test } from '@nestjs/testing';
import { LanguageService } from './language.service';

describe('LanguageService', () => {
  let service: LanguageService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [LanguageService],
    }).compile();

    service = module.get(LanguageService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
