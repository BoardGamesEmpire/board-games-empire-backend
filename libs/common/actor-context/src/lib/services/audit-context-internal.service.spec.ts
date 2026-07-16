import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { Actor } from '../types';
import { type ActorContextInit, AuditContextInternalService } from './audit-context-internal.service';
import { ACTOR_CLS_KEY, AuditContextService, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY } from './audit-context.service';

describe('AuditContextInternalService', () => {
  let module: TestingModule;
  let internal: AuditContextInternalService;
  let context: AuditContextService;
  let cls: ClsService;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({
          global: true,
          middleware: { mount: false },
        }),
      ],
      providers: [AuditContextService, AuditContextInternalService],
    }).compile();

    internal = module.get(AuditContextInternalService);
    context = module.get(AuditContextService);
    cls = module.get(ClsService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('runWith', () => {
    it('populates actor + correlation + source inside the scope', () => {
      const actor: Actor = { kind: 'user', userId: 'u1' };
      const init: ActorContextInit = {
        actor,
        correlationId: 'corr-1',
        source: 'http',
      };

      const captured = internal.runWith(init, () => ({
        actor: context.getActor(),
        correlationId: context.getCorrelationId(),
        source: context.getSource(),
      }));

      expect(captured).toEqual({
        actor,
        correlationId: 'corr-1',
        source: 'http',
      });
    });

    it('allows a null actor (unauthenticated request)', () => {
      const init: ActorContextInit = {
        actor: null,
        correlationId: 'corr-2',
        source: 'http',
      };

      const actor = internal.runWith(init, () => context.getActor());
      expect(actor).toBeNull();
    });

    it('does not leak between sibling scopes', () => {
      const first: ActorContextInit = {
        actor: { kind: 'user', userId: 'u1' },
        correlationId: 'corr-1',
        source: 'http',
      };
      const second: ActorContextInit = {
        actor: { kind: 'apiKey', apiKeyId: 'k1', userId: 'u2' },
        correlationId: 'corr-2',
        source: 'http',
      };

      const firstSeen = internal.runWith(first, () => context.getActor());
      const secondSeen = internal.runWith(second, () => context.getActor());

      expect(firstSeen).toEqual(first.actor);
      expect(secondSeen).toEqual(second.actor);
    });

    it('returns the result of the inner function', () => {
      const result = internal.runWith(
        {
          actor: { kind: 'system', reason: 'test' },
          correlationId: 'c',
          source: 'system',
        },
        () => 42,
      );
      expect(result).toBe(42);
    });

    it('populates the locale when the seam carries one', () => {
      const locale = internal.runWith(
        { actor: null, correlationId: 'c', source: 'queue', locale: 'de' },
        () => context.getLocale(),
      );
      expect(locale).toBe('de');
    });

    it('keeps the inherited locale when a nested scope carries none', () => {
      const locale = internal.runWith({ actor: null, correlationId: 'c', source: 'http', locale: 'de' }, () =>
        internal.runWith({ actor: { kind: 'system', reason: 'nested' }, correlationId: 'c2', source: 'system' }, () =>
          context.getLocale(),
        ),
      );
      expect(locale).toBe('de');
    });
  });

  describe('populate', () => {
    it('throws when called outside a CLS scope', () => {
      expect(() =>
        internal.populate({
          actor: { kind: 'system', reason: 'x' },
          correlationId: 'c',
          source: 'system',
        }),
      ).toThrow(/active CLS scope/);
    });

    it('writes the locale only when the seam carries one', async () => {
      await cls.run(() => {
        internal.populate({ actor: null, correlationId: 'c', source: 'queue', locale: 'de' });
        expect(context.getLocale()).toBe('de');

        internal.populate({ actor: null, correlationId: 'c2', source: 'queue' });
        expect(context.getLocale()).toBe('de');
      });
    });

    it('writes into the current CLS scope', async () => {
      const init: ActorContextInit = {
        actor: { kind: 'apiKey', apiKeyId: 'k1', userId: 'u1' },
        correlationId: 'corr-x',
        source: 'http',
      };

      await cls.run(() => {
        internal.populate(init);

        expect(cls.get(ACTOR_CLS_KEY)).toEqual(init.actor);
        expect(cls.get(CORRELATION_ID_CLS_KEY)).toBe('corr-x');
        expect(cls.get(SOURCE_CLS_KEY)).toBe('http');
      });
    });
  });

  describe('setLocale', () => {
    it('throws when called outside a CLS scope', () => {
      expect(() => internal.setLocale('en')).toThrow(/active CLS scope/);
    });

    it('sets the locale readable via AuditContextService', async () => {
      await cls.run(() => {
        expect(context.getLocale()).toBeNull();

        internal.setLocale('en');
        expect(context.getLocale()).toBe('en');
      });
    });
  });
});
