import { AuditContextService } from '@bge/actor-context';
import {
  ACTOR_CLS_KEY,
  AuditContextInternalService,
  CORRELATION_ID_CLS_KEY,
  SOURCE_CLS_KEY,
} from '@bge/actor-context/internal';
import type { BaseClientData } from '@bge/shared';
import { ExecutionContext, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';
import { WsActorInterceptor } from './ws-actor.interceptor';

interface MockSocket {
  readonly id: string;
  data: unknown;
}

type HttpArgumentsHost = ReturnType<ExecutionContext['switchToHttp']>;
type WsArgumentsHost = ReturnType<ExecutionContext['switchToWs']>;

const stubHttpHost = (): HttpArgumentsHost => ({
  getRequest: <T>() => ({}) as T,
  getResponse: <T>() => ({}) as T,
  getNext: <T>() => undefined as T,
});

const stubWsHost = (client: MockSocket): WsArgumentsHost => ({
  getClient: <T>() => client as T,
  getData: <T>() => ({}) as T,
  getPattern: () => '',
});

const buildWsContext = (client: MockSocket, type: 'ws' | 'http' | 'rpc' = 'ws'): ExecutionContext =>
  ({
    switchToWs: () => stubWsHost(client),
    switchToHttp: () => stubHttpHost(),
    getType: <T extends string>() => type as T,
  }) satisfies Partial<ExecutionContext> as ExecutionContext;

interface Captured {
  readonly actor: unknown;
  readonly correlationId: unknown;
  readonly source: unknown;
}

describe('WsActorInterceptor', () => {
  let module: TestingModule;
  let interceptor: WsActorInterceptor;
  let cls: ClsService;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [AuditContextService, AuditContextInternalService, WsActorInterceptor],
    }).compile();

    interceptor = module.get(WsActorInterceptor);
    cls = module.get(ClsService);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    await module.close();
  });

  const run = async (client: MockSocket, type: 'ws' | 'http' | 'rpc' = 'ws'): Promise<Captured> => {
    let captured: Captured = {
      actor: undefined,
      correlationId: undefined,
      source: undefined,
    };

    await cls.run(async () => {
      const result$ = await interceptor.intercept(buildWsContext(client, type), { handle: () => of('next') });
      await firstValueFrom(result$);
      captured = {
        actor: cls.get(ACTOR_CLS_KEY),
        correlationId: cls.get(CORRELATION_ID_CLS_KEY),
        source: cls.get(SOURCE_CLS_KEY),
      };
    });

    return captured;
  };

  describe('populated client.data', () => {
    it('populates CLS from socket.data', async () => {
      const data: BaseClientData = {
        userId: 'user-7',
        actor: { kind: 'user', userId: 'user-7' },
        correlationId: 'corr-ws-1',
      };
      const captured = await run({ id: 'socket-1', data });

      expect(captured).toEqual({
        actor: { kind: 'user', userId: 'user-7' },
        correlationId: 'corr-ws-1',
        source: 'ws',
      });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('produces an isolated CLS scope per call', async () => {
      const a: BaseClientData = {
        userId: 'a',
        actor: { kind: 'user', userId: 'a' },
        correlationId: 'c-a',
      };
      const b: BaseClientData = {
        userId: 'b',
        actor: { kind: 'user', userId: 'b' },
        correlationId: 'c-b',
      };

      const [first, second] = await Promise.all([run({ id: 's-a', data: a }), run({ id: 's-b', data: b })]);

      expect(first.actor).toEqual(a.actor);
      expect(second.actor).toEqual(b.actor);
    });
  });

  describe('missing or malformed client.data', () => {
    it('logs an error and does not populate CLS when data is undefined', async () => {
      const captured = await run({ id: 'socket-x', data: undefined });

      expect(captured).toEqual({
        actor: undefined,
        correlationId: undefined,
        source: undefined,
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/without populated client\.data/));
    });

    it('logs an error when actor is missing from data', async () => {
      const partial: Partial<BaseClientData> = {
        userId: 'u',
        correlationId: 'c',
      };
      await run({ id: 'socket-x', data: partial });

      expect(errorSpy).toHaveBeenCalled();
    });

    it('logs an error when correlationId is missing from data', async () => {
      const partial: Partial<BaseClientData> = {
        userId: 'u',
        actor: { kind: 'user', userId: 'u' },
      };
      await run({ id: 'socket-x', data: partial });

      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('non-ws contexts', () => {
    it('is a no-op for http requests', async () => {
      const data: BaseClientData = {
        userId: 'u',
        actor: { kind: 'user', userId: 'u' },
        correlationId: 'c',
      };
      const captured = await run({ id: 's', data }, 'http');

      expect(captured.actor).toBeUndefined();
      expect(captured.source).toBeUndefined();
    });

    it('is a no-op for rpc requests', async () => {
      const data: BaseClientData = {
        userId: 'u',
        actor: { kind: 'user', userId: 'u' },
        correlationId: 'c',
      };
      const captured = await run({ id: 's', data }, 'rpc');

      expect(captured.actor).toBeUndefined();
      expect(captured.source).toBeUndefined();
    });
  });
});
