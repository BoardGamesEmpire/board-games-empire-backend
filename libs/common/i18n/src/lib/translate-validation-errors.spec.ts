import { AuditContextService } from '@bge/actor-context';
import { I18N_CATALOG_DIR, i18nValidationMessage, type I18nTranslations } from '@bge/i18n-core';
import { Test } from '@nestjs/testing';
import { IsIn, IsString, IsUUID } from 'class-validator';
import { I18nModule, I18nService, I18nValidationException, I18nValidationPipe } from 'nestjs-i18n';
import { FALLBACK_LOCALE } from './locale.constants';
import { translateValidationErrors } from './translate-validation-errors';

const VALID_UUID = '9f1c2c8e-8a4e-4c1e-9d0e-3c2b1a0f9e8d';

class SearchLikeDto {
  @IsUUID()
  correlationId!: string;

  @IsString({ message: i18nValidationMessage('validation.isString') })
  query!: string;
}

class ActionDto {
  @IsIn(['create', 'update', 'delete'], { message: i18nValidationMessage('validation.isIn') })
  action!: string;
}

/**
 * What `I18nValidationPipe` throws where no nestjs-i18n context exists, as on a
 * WebSocket frame: the errors still carry their raw markers.
 */
function validationFailure(metatype: new () => object, payload: object): Promise<I18nValidationException> {
  return new I18nValidationPipe().transform(payload, { type: 'body', metatype }).then(
    () => {
      throw new Error('expected the payload to fail validation');
    },
    (error: I18nValidationException) => error,
  );
}

describe('translateValidationErrors (real catalog)', () => {
  let i18n: I18nService<I18nTranslations>;
  let locale: string | null;
  const auditContext = { getLocale: () => locale } as unknown as AuditContextService;

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

  beforeEach(() => {
    locale = FALLBACK_LOCALE;
  });

  afterEach(() => jest.restoreAllMocks());

  // The expected copy is class-validator's own wording for these decorators,
  // which is what the HTTP body carries for the same failure.
  it('renders each failed constraint as the HTTP body does, marker or not', async () => {
    const exception = await validationFailure(SearchLikeDto, { correlationId: 'not-a-uuid', query: 42 });

    expect(translateValidationErrors(exception, i18n, auditContext)).toEqual([
      'correlationId must be a UUID',
      'query must be a string',
    ]);
  });

  it('joins a list constraint with ", ", as class-validator does', async () => {
    const exception = await validationFailure(ActionDto, { action: 'upsert' });

    expect(translateValidationErrors(exception, i18n, auditContext)).toEqual([
      'action must be one of the following values: create, update, delete',
    ]);
  });

  it("translates in the frame's locale", async () => {
    locale = 'fr';
    const translate = jest.spyOn(i18n, 'translate');
    const exception = await validationFailure(SearchLikeDto, { correlationId: VALID_UUID, query: 42 });

    translateValidationErrors(exception, i18n, auditContext);

    expect(translate).toHaveBeenCalledWith('validation.isString', expect.objectContaining({ lang: 'fr' }));
  });

  it('falls back to the fallback locale outside a CLS scope', async () => {
    const outsideScope = {
      getLocale: () => {
        throw new Error('no active CLS scope');
      },
    } as unknown as AuditContextService;
    const translate = jest.spyOn(i18n, 'translate');
    const exception = await validationFailure(SearchLikeDto, { correlationId: VALID_UUID, query: 42 });

    expect(translateValidationErrors(exception, i18n, outsideScope)).toEqual(['query must be a string']);
    expect(translate).toHaveBeenCalledWith('validation.isString', expect.objectContaining({ lang: FALLBACK_LOCALE }));
  });

  it('leaves errors the pipe already translated as they are', () => {
    const translate = jest.spyOn(i18n, 'translate');
    const exception = new I18nValidationException(
      [{ property: 'query', constraints: { isString: 'query doit être une chaîne' }, children: [] }],
      400,
      true,
    );

    expect(translateValidationErrors(exception, i18n, auditContext)).toEqual(['query doit être une chaîne']);
    expect(translate).not.toHaveBeenCalled();
  });
});
