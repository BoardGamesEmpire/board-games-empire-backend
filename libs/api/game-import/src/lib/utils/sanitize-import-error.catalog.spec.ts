import { FALLBACK_LOCALE, I18N_CATALOG_DIR, type I18nTranslations } from '@bge/i18n';
import { Test } from '@nestjs/testing';
import { I18nModule, I18nService } from 'nestjs-i18n';
import { ImportErrorCode, importErrorMarker, importErrorMessage } from './sanitize-import-error';

/**
 * Each failure code has two renderings: the static English copy that the
 * webhook payload and `Job.result` carry, and the catalog key that the user's
 * own surfaces (the status read-back, the ImportFailed notification) translate.
 * They must say the same thing, so a webhook receiver's log and the user's
 * screen never disagree about why an import failed. Checked against the REAL
 * shipped catalog: a missing key renders as the key itself and fails here.
 */
describe('import failure copy (real catalog)', () => {
  let i18n: I18nService<I18nTranslations>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          fallbackLanguage: FALLBACK_LOCALE,
          loaderOptions: { path: I18N_CATALOG_DIR, watch: false },
        }),
      ],
    }).compile();

    i18n = moduleRef.get(I18nService);
  });

  it.each(Object.values(ImportErrorCode))('%s: the static English copy is the en catalog text', (code) => {
    const marker = importErrorMarker(code);

    expect(i18n.translate(marker.key, { lang: FALLBACK_LOCALE, args: marker.args })).toBe(importErrorMessage(code));
  });
});
