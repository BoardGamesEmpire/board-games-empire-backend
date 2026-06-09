import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { Actor } from '../types';
import { ACTOR_CLS_KEY, AuditContextService, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY } from './audit-context.service';

describe('AuditContextService', () => {
  let module: TestingModule;
  let service: AuditContextService;
  let cls: ClsService;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({
          global: true,
          middleware: { mount: false },
        }),
      ],
      providers: [AuditContextService],
    }).compile();

    service = module.get(AuditContextService);
    cls = module.get(ClsService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('getActor', () => {
    it('returns null when no actor is set', async () => {
      await cls.run(() => {
        expect(service.getActor()).toBeNull();
      });
    });

    it('returns the actor populated in CLS', async () => {
      const actor: Actor = { kind: 'user', userId: 'user-1' };

      await cls.run(() => {
        cls.set(ACTOR_CLS_KEY, actor);
        expect(service.getActor()).toEqual(actor);
      });
    });

    it('does not leak between independent CLS scopes', async () => {
      const actor: Actor = { kind: 'user', userId: 'user-1' };

      await cls.run(() => {
        cls.set(ACTOR_CLS_KEY, actor);
      });

      await cls.run(() => {
        expect(service.getActor()).toBeNull();
      });
    });
  });

  describe('getActorOrThrow', () => {
    it('returns the actor when set', async () => {
      const actor: Actor = {
        kind: 'apiKey',
        apiKeyId: 'k1',
        userId: 'u1',
      };

      await cls.run(() => {
        cls.set(ACTOR_CLS_KEY, actor);
        expect(service.getActorOrThrow()).toEqual(actor);
      });
    });

    it('throws when no actor is populated', async () => {
      await cls.run(() => {
        expect(() => service.getActorOrThrow()).toThrow(/populated CLS scope/);
      });
    });
  });

  describe('getCorrelationId', () => {
    it('returns null when unset', async () => {
      await cls.run(() => {
        expect(service.getCorrelationId()).toBeNull();
      });
    });

    it('returns the populated correlation id', async () => {
      await cls.run(() => {
        cls.set(CORRELATION_ID_CLS_KEY, 'corr-1');
        expect(service.getCorrelationId()).toBe('corr-1');
      });
    });
  });

  describe('getSource', () => {
    it('returns null when unset', async () => {
      await cls.run(() => {
        expect(service.getSource()).toBeNull();
      });
    });

    it('returns the populated source', async () => {
      await cls.run(() => {
        cls.set(SOURCE_CLS_KEY, 'http');
        expect(service.getSource()).toBe('http');
      });
    });
  });
});
