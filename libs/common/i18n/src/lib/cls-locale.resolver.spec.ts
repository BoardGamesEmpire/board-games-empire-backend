import { LOCALE_CLS_KEY } from '@bge/actor-context';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ClsLocaleResolver } from './cls-locale.resolver';

describe('ClsLocaleResolver', () => {
  let module: TestingModule;
  let cls: ClsService;
  let resolver: ClsLocaleResolver;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [ClsLocaleResolver],
    }).compile();

    cls = module.get(ClsService);
    resolver = module.get(ClsLocaleResolver);
  });

  afterEach(async () => {
    await module.close();
  });

  it('returns the locale stored in the CLS envelope', () => {
    cls.run(() => {
      cls.set(LOCALE_CLS_KEY, 'de');
      expect(resolver.resolve()).toBe('de');
    });
  });

  it('returns undefined inside a scope with no resolved locale', () => {
    cls.run(() => {
      expect(resolver.resolve()).toBeUndefined();
    });
  });

  it('returns undefined outside any CLS scope (defers to fallbackLanguage)', () => {
    expect(resolver.resolve()).toBeUndefined();
  });
});
