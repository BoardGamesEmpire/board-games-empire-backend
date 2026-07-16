import { AuditContextInternalService, AuditContextService, type Actor } from '@bge/actor-context';
import { FALLBACK_LOCALE, LocaleResolutionService } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { ClsModule, ClsService } from 'nestjs-cls';
import { LocaleResolutionMiddleware } from './locale-resolution.middleware';

type ResolutionMock = jest.Mocked<Pick<LocaleResolutionService, 'resolve'>>;

const buildRequest = (headers: Record<string, string | undefined> = {}): Request =>
  ({ headers }) as unknown as Request;

describe('LocaleResolutionMiddleware', () => {
  let module: TestingModule;
  let middleware: LocaleResolutionMiddleware;
  let cls: ClsService;
  let auditContext: AuditContextService;
  let internal: AuditContextInternalService;
  let resolutionMock: ResolutionMock;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    resolutionMock = { resolve: jest.fn().mockResolvedValue('de') };

    module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [
        AuditContextService,
        AuditContextInternalService,
        { provide: LocaleResolutionService, useValue: resolutionMock },
        LocaleResolutionMiddleware,
      ],
    }).compile();

    middleware = module.get(LocaleResolutionMiddleware);
    cls = module.get(ClsService);
    auditContext = module.get(AuditContextService);
    internal = module.get(AuditContextInternalService);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await module.close();
  });

  interface Captured {
    readonly locale: string | null;
    readonly nextArg: unknown;
  }

  /**
   * Drives the middleware inside a populated CLS scope (mimicking
   * ClsMiddleware + HttpActorMiddleware having run first).
   */
  const run = async (request: Request, actor: Actor | null): Promise<Captured> => {
    let captured: Captured = { locale: null, nextArg: undefined };

    await cls.run(async () => {
      internal.populate({ actor, correlationId: 'test', source: 'http' });

      const next: NextFunction = (arg) => {
        captured = { locale: auditContext.getLocale(), nextArg: arg };
      };

      await middleware.use(request, {} as Response, next);
    });

    return captured;
  };

  it('stores the resolved locale in the CLS envelope', async () => {
    const captured = await run(buildRequest({ 'accept-language': 'de-CH, en;q=0.5' }), {
      kind: 'user',
      userId: 'u1',
    });

    expect(resolutionMock.resolve).toHaveBeenCalledWith({ userId: 'u1', acceptLanguage: 'de-CH, en;q=0.5' });
    expect(captured.locale).toBe('de');
    expect(captured.nextArg).toBeUndefined();
  });

  it.each<[string, Actor]>([
    ['anonymous', { kind: 'anonymous', userId: 'u2' }],
    ['apiKey', { kind: 'apiKey', apiKeyId: 'k1', userId: 'u3' }],
  ])('passes the %s actor userId to resolution', async (_kind, actor) => {
    await run(buildRequest(), actor);

    expect(resolutionMock.resolve).toHaveBeenCalledWith({ userId: actor.userId, acceptLanguage: undefined });
  });

  it('passes a null userId for unauthenticated requests', async () => {
    await run(buildRequest({ 'accept-language': 'en' }), null);

    expect(resolutionMock.resolve).toHaveBeenCalledWith({ userId: null, acceptLanguage: 'en' });
  });

  it('passes a null userId for actors without a backing user', async () => {
    await run(buildRequest(), { kind: 'system', reason: 'test' });

    expect(resolutionMock.resolve).toHaveBeenCalledWith({ userId: null, acceptLanguage: undefined });
  });

  it(`degrades to '${FALLBACK_LOCALE}' when resolution fails, without failing the request`, async () => {
    resolutionMock.resolve.mockRejectedValue(new Error('boom'));

    const captured = await run(buildRequest(), { kind: 'user', userId: 'u1' });

    expect(captured.locale).toBe(FALLBACK_LOCALE);
    expect(captured.nextArg).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('forwards wiring errors to next() (no active CLS scope)', async () => {
    let nextArg: unknown;
    const next: NextFunction = (arg) => {
      nextArg = arg;
    };

    await middleware.use(buildRequest(), {} as Response, next);

    expect(nextArg).toBeInstanceOf(Error);
  });
});
