import {
  ACTOR_CLS_KEY,
  AuditContextInternalService,
  AuditContextService,
  CORRELATION_ID_CLS_KEY,
  SOURCE_CLS_KEY,
} from '@bge/actor-context';
import { Metadata } from '@grpc/grpc-js';
import { type CallHandler, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { Observable, firstValueFrom, of } from 'rxjs';
import { GATEWAY_ID_METADATA_KEY, GrpcActorInterceptor } from './grpc-actor.interceptor';

interface Captured {
  actor: unknown;
  correlationId: unknown;
  source: unknown;
}

type RpcArgumentsHost = ReturnType<ExecutionContext['switchToRpc']>;

const stubRpcHost = (metadata: Metadata): RpcArgumentsHost => ({
  getData: <T>() => ({}) as T,
  getContext: <T>() => metadata as T,
});

const buildContext = (metadata: Metadata): ExecutionContext =>
  ({
    switchToRpc: () => stubRpcHost(metadata),
    getType: <T extends string>() => 'rpc' as T,
  }) satisfies Partial<ExecutionContext> as ExecutionContext;

describe('GrpcActorInterceptor', () => {
  let module: TestingModule;
  let interceptor: GrpcActorInterceptor;
  let cls: ClsService;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [AuditContextService, AuditContextInternalService, GrpcActorInterceptor],
    }).compile();

    interceptor = module.get(GrpcActorInterceptor);
    cls = module.get(ClsService);
  });

  afterEach(async () => {
    await module.close();
  });

  /**
   * Drives the interceptor with a CallHandler that captures CLS state from
   * within the runWith scope (where the actual handler would emit).
   */
  const run = async (metadata: Metadata): Promise<Captured> => {
    const captured: Captured = {
      actor: undefined,
      correlationId: undefined,
      source: undefined,
    };

    const handler: CallHandler = {
      handle: () =>
        new Observable<string>((subscriber) => {
          captured.actor = cls.get(ACTOR_CLS_KEY);
          captured.correlationId = cls.get(CORRELATION_ID_CLS_KEY);
          captured.source = cls.get(SOURCE_CLS_KEY);
          subscriber.next('next-result');
          subscriber.complete();
        }),
    };

    const result$ = interceptor.intercept(buildContext(metadata), handler);
    await firstValueFrom(result$);
    return captured;
  };

  it('opens a CLS scope with the external gateway actor', async () => {
    const metadata = new Metadata();
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-bgg');

    const captured = await run(metadata);

    expect(captured.actor).toEqual({
      kind: 'external',
      system: 'gateway',
      identifier: 'gateway-bgg',
    });
    expect(captured.source).toBe('grpc');
  });

  it('reads correlation id from traceparent metadata', async () => {
    const metadata = new Metadata();
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-igdb');
    metadata.set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');

    const captured = await run(metadata);
    expect(captured.correlationId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('falls back to x-correlation-id metadata when traceparent is absent', async () => {
    const metadata = new Metadata();
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-igdb');
    metadata.set('x-correlation-id', 'corr-grpc-1');

    const captured = await run(metadata);
    expect(captured.correlationId).toBe('corr-grpc-1');
  });

  it('generates a correlation id when no headers are present', async () => {
    const metadata = new Metadata();
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-bgg');

    const captured = await run(metadata);
    expect(captured.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('throws UnauthorizedException when gateway id metadata is missing', async () => {
    const metadata = new Metadata();
    const handler: CallHandler = { handle: () => of('never') };

    expect(() => interceptor.intercept(buildContext(metadata), handler)).toThrow(UnauthorizedException);
  });

  it('unwraps a { metadata } envelope shape', async () => {
    const metadata = new Metadata();
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-wrap');

    const envelopeContext = {
      switchToRpc: () => ({
        getData: () => ({}),
        getContext: () => ({ metadata }),
      }),
      getType: () => 'rpc',
    } as unknown as ExecutionContext;

    const captured: Captured = {
      actor: undefined,
      correlationId: undefined,
      source: undefined,
    };

    const handler: CallHandler = {
      handle: () =>
        new Observable<string>((sub) => {
          captured.actor = cls.get(ACTOR_CLS_KEY);
          sub.next('x');
          sub.complete();
        }),
    };

    await firstValueFrom(interceptor.intercept(envelopeContext, handler));

    expect(captured.actor).toEqual({
      kind: 'external',
      system: 'gateway',
      identifier: 'gateway-wrap',
    });
  });

  it('produces isolated scopes per call', async () => {
    const metaA = new Metadata();
    metaA.set(GATEWAY_ID_METADATA_KEY, 'gw-a');
    const metaB = new Metadata();
    metaB.set(GATEWAY_ID_METADATA_KEY, 'gw-b');

    const [a, b] = await Promise.all([run(metaA), run(metaB)]);

    expect((a.actor as { identifier: string }).identifier).toBe('gw-a');
    expect((b.actor as { identifier: string }).identifier).toBe('gw-b');
  });

  it('is a no-op for non-rpc execution contexts', async () => {
    const httpContext = {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => ({}),
        getNext: () => undefined,
      }),
      getType: () => 'http',
    } as unknown as ExecutionContext;

    const captured: Captured = {
      actor: undefined,
      correlationId: undefined,
      source: undefined,
    };

    const handler: CallHandler = {
      handle: () =>
        new Observable<string>((sub) => {
          captured.actor = cls.get(ACTOR_CLS_KEY);
          captured.source = cls.get(SOURCE_CLS_KEY);
          sub.next('x');
          sub.complete();
        }),
    };

    await firstValueFrom(interceptor.intercept(httpContext, handler));

    // No scope opened: CLS lookups return undefined outside any active scope.
    expect(captured.actor).toBeUndefined();
    expect(captured.source).toBeUndefined();
  });
});
