import { DatabaseService } from '@bge/database';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { I18nService } from 'nestjs-i18n';
import { ClsLocaleResolver } from './cls-locale.resolver';
import { I18nConfigModule } from './i18n.module';
import { SupportedLocalesService } from './supported-locales.service';

describe('I18nConfigModule', () => {
  let moduleRef: TestingModule;
  let i18n: I18nService;

  beforeAll(async () => {
    const dbMock = {
      languageTag: { findMany: jest.fn().mockResolvedValue([{ tag: 'en' }]) },
    };

    moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } }), I18nConfigModule],
    })
      .overrideProvider(DatabaseService)
      .useValue(dbMock)
      .compile();

    await moduleRef.init();

    i18n = moduleRef.get(I18nService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('resolves a key from the en catalog', () => {
    expect(i18n.translate('common.at_least_one_field', { lang: 'en' })).toBe('At least one field must be provided');
  });

  it('falls back to en for an unsupported locale', () => {
    expect(i18n.translate('common.at_least_one_field', { lang: 'fr' })).toBe('At least one field must be provided');
  });

  it('loads the supported-locale set at boot', () => {
    expect(moduleRef.get(SupportedLocalesService).getSupportedTags()).toEqual(['en']);
  });

  it('registers the CLS resolver inside the I18nModule context', () => {
    // Verifies the DI wiring: nestjs-i18n instantiates resolver classes in its
    // own module context, so this throws if the resolver's dependencies are
    // not globally visible there.
    expect(moduleRef.get(ClsLocaleResolver, { strict: false })).toBeInstanceOf(ClsLocaleResolver);
  });
});
