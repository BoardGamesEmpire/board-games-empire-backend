import { t } from '@bge/i18n-core';
import { ForbiddenException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { SERVER_PLUGIN_UNIT, type Actor } from '../types';
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

  // `resolveScopeSubjectId` turns this refusal into the 403 a first-person
  // list read gives an actor with no user behind it (#417). No HTTP request
  // arrives as one of those kinds, so this is the only place the real switch
  // is pinned: were it to answer with an id instead, those reads would return
  // an empty page, telling a client its memberships had been removed.
  describe('getActingUserId', () => {
    it.each<[string, Actor]>([
      ['user', { kind: 'user', userId: 'user-1' }],
      ['anonymous', { kind: 'anonymous', userId: 'user-1' }],
      ['apiKey', { kind: 'apiKey', apiKeyId: 'key-1', userId: 'user-1' }],
    ])('returns the backing user of a %s actor', async (_kind, actor) => {
      await cls.run(() => {
        cls.set(ACTOR_CLS_KEY, actor);
        expect(service.getActingUserId()).toBe('user-1');
      });
    });

    // The plugin carries a user trigger on purpose: acting on a user's behalf
    // does not make the user its subject until polymorphic attribution exists.
    // A plugin acting inside a request carries the refusal to an HTTP response,
    // so it names a catalog key, with the refused kind, for the edge to translate.
    it.each<[string, Actor]>([
      [
        'plugin',
        {
          kind: 'plugin',
          pluginId: 'plugin-foo',
          unit: SERVER_PLUGIN_UNIT,
          trigger: { kind: 'user', userId: 'user-1' },
        },
      ],
      ['system', { kind: 'system', reason: 'migration' }],
      ['external', { kind: 'external', system: 'gateway', identifier: 'gateway-bgg' }],
    ])('refuses a %s actor with a 403 rather than answering with an id', async (kind, actor) => {
      await cls.run(() => {
        cls.set(ACTOR_CLS_KEY, actor);
        let error: unknown;
        try {
          service.getActingUserId();
        } catch (caught) {
          error = caught;
        }

        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toEqual(
          t('errors.actor_context.not_user_attributable', { kind }),
        );
      });
    });

    it('fails with a plain error, not a 403, when no actor is populated', async () => {
      await cls.run(() => {
        expect(() => service.getActingUserId()).toThrow('getActingUserId called with no actor in context');
        expect(() => service.getActingUserId()).not.toThrow(ForbiddenException);
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
