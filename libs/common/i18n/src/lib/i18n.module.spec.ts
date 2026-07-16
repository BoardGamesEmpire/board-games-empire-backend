import { Test } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { I18nConfigModule } from './i18n.module';

describe('I18nConfigModule', () => {
  let i18n: I18nService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [I18nConfigModule],
    }).compile();

    i18n = moduleRef.get(I18nService);
  });

  it('resolves a key from the en catalog', () => {
    expect(i18n.translate('common.at_least_one_field', { lang: 'en' })).toBe('At least one field must be provided');
  });

  it('falls back to en for an unsupported locale', () => {
    expect(i18n.translate('common.at_least_one_field', { lang: 'fr' })).toBe('At least one field must be provided');
  });
});
