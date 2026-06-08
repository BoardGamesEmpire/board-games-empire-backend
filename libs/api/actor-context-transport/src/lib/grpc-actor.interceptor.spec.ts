import { AuditContextService } from '@bge/actor-context';
import {
  ACTOR_CLS_KEY,
  AuditContextInternalService,
  CORRELATION_ID_CLS_KEY,
  SOURCE_CLS_KEY,
} from '@bge/actor-context/internal';
import { Metadata } from '@grpc/grpc-js';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';

import { GATEWAY_ID_METADATA_KEY, GrpcActorInterceptor } from './grpc-actor.interceptor';

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

  const run = async (metadata: Metadata): Promise<{ actor: unknown; correlationId: unknown; source: unknown }> => {
    let captured = {};
    await cls.run(async () => {
      const result$ = await interceptor.intercept(buildContext(metadata), {
        handle: () => of('next'),
      });
      await firstValueFrom(result$);
      captured = {
        actor: cls.get(ACTOR_CLS_KEY),
        correlationId: cls.get(CORRELATION_ID_CLS_KEY),
        source: cls.get(SOURCE_CLS_KEY),
      };
    });
    return captured as ReturnType<typeof run> extends Promise<infer R> ? R : never;
  };

  it('populates external gateway actor from metadata', async () => {
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

  it('falls back to x-correlation-id metadata', async () => {
    const metadata = new Metadata();
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-igdb');
    metadata.set('x-correlation-id', 'corr-grpc-1');

    const captured = await run(metadata);
    expect(captured.correlationId).toBe('corr-grpc-1');
  });

  it('generates a correlation id when no headers present', async () => {
    const metadata = new Metadata();
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-bgg');

    const captured = await run(metadata);
    expect(captured.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('throws UnauthorizedException when gateway id metadata is missing', async () => {
    const metadata = new Metadata();
    await expect(run(metadata)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts buffer-valued metadata for the gateway id', async () => {
    const metadata = new Metadata();
    metadata.set(`${GATEWAY_ID_METADATA_KEY}-bin`, Buffer.from('gateway-bin', 'utf-8'));
    // The interceptor key is x-bge-gateway-id (string), not bin — switch.
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-bin');

    const captured = await run(metadata);
    expect(captured.actor).toEqual({
      kind: 'external',
      system: 'gateway',
      identifier: 'gateway-bin',
    });
  });

  it('unwraps when context is { metadata } envelope shape', async () => {
    const metadata = new Metadata();
    metadata.set(GATEWAY_ID_METADATA_KEY, 'gateway-wrap');

    const envelopeContext = {
      switchToRpc: () => ({
        getData: () => ({}),
        getContext: () => ({ metadata }),
      }),
      getType: () => 'rpc',
    } as unknown as ExecutionContext;

    let actor: unknown;
    await cls.run(async () => {
      const result$ = await interceptor.intercept(envelopeContext, {
        handle: () => of('next'),
      });
      await firstValueFrom(result$);
      actor = cls.get(ACTOR_CLS_KEY);
    });

    expect(actor).toEqual({
      kind: 'external',
      system: 'gateway',
      identifier: 'gateway-wrap',
    });
  });
});
