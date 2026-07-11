import type { Actor, ActorContextInit, AuditContextInternalService } from '@bge/actor-context';
import { BGE_ACTOR_HEADER, CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import { Metadata } from '@grpc/grpc-js';
import { BadRequestException, type CallHandler, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { SKIP_ACTOR_CONTEXT_KEY } from '../decorators/skip-actor-context.decorator';
import { GrpcInternalActorInterceptor, validateActorShape } from './grpc-internal-actor.interceptor';

interface MockAuditContext {
  runWith: jest.Mock<unknown, [ActorContextInit, () => unknown]>;
}

const buildMockAuditContext = (): MockAuditContext => ({
  runWith: jest.fn((_init: ActorContextInit, fn: () => unknown) => fn()),
});

const buildMetadata = (entries: Record<string, string> = {}): Metadata => {
  const md = new Metadata();
  for (const [key, value] of Object.entries(entries)) {
    md.set(key, value);
  }
  return md;
};

const encodeActor = (actor: unknown): string => Buffer.from(JSON.stringify(actor), 'utf8').toString('base64');

const buildRpcExecutionContext = (metadataOrWrapper: Metadata | { metadata: Metadata } | undefined): ExecutionContext =>
  ({
    getType: () => 'rpc',
    switchToRpc: () => ({
      getContext: () => metadataOrWrapper,
      getData: () => ({}),
    }),
    switchToHttp: () => ({}) as never,
    switchToWs: () => ({}) as never,
    getClass: () => ({}) as never,
    getHandler: () => ({}) as never,
    getArgs: () => [],
    getArgByIndex: () => undefined as never,
  }) as unknown as ExecutionContext;

const buildCallHandler = (): jest.Mocked<CallHandler> => ({
  handle: jest.fn(() => of('next-result')),
});

const buildReflector = (skip = false): Reflector =>
  ({ getAllAndOverride: jest.fn().mockReturnValue(skip) }) as unknown as Reflector;

const buildInterceptor = (
  auditContext: MockAuditContext,
  reflector: Reflector = buildReflector(),
): GrpcInternalActorInterceptor =>
  new GrpcInternalActorInterceptor(auditContext as unknown as AuditContextInternalService, reflector);

describe('GrpcInternalActorInterceptor', () => {
  describe('happy path — actor extraction', () => {
    it('extracts a user actor and populates CLS via runWith', async () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      const metadata = buildMetadata({
        [BGE_ACTOR_HEADER]: encodeActor(actor),
        [CORRELATION_ID_HEADER]: 'corr-xyz',
      });
      const next = buildCallHandler();

      const result = interceptor.intercept(buildRpcExecutionContext(metadata), next);
      await firstValueFrom(result);

      expect(auditContext.runWith).toHaveBeenCalledTimes(1);
      const [init] = auditContext.runWith.mock.calls[0];
      expect(init.actor).toEqual(actor);
      expect(init.correlationId).toBe('corr-xyz');
      expect(init.source).toBe('grpc');
      expect(next.handle).toHaveBeenCalledTimes(1);
    });

    it('unwraps a { metadata } wrapper shape produced by some gRPC adapters', async () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);
      const actor: Actor = { kind: 'system', reason: 'scheduler' };
      const metadata = buildMetadata({ [BGE_ACTOR_HEADER]: encodeActor(actor) });
      const next = buildCallHandler();

      const result = interceptor.intercept(buildRpcExecutionContext({ metadata }), next);
      await firstValueFrom(result);

      const [init] = auditContext.runWith.mock.calls[0];
      expect(init.actor).toEqual(actor);
    });

    it('falls back to traceparent when x-correlation-id is absent', async () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      const metadata = buildMetadata({
        [BGE_ACTOR_HEADER]: encodeActor(actor),
        [TRACEPARENT_HEADER]: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      });
      const next = buildCallHandler();

      await firstValueFrom(interceptor.intercept(buildRpcExecutionContext(metadata), next));

      const [init] = auditContext.runWith.mock.calls[0];
      expect(init.correlationId).toBeDefined();
      expect(typeof init.correlationId).toBe('string');
    });
  });

  describe('error cases — missing or malformed header', () => {
    it('throws UnauthorizedException when x-bge-actor is absent', () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);
      const metadata = buildMetadata();

      expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
        UnauthorizedException,
      );
      expect(auditContext.runWith).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when metadata itself is missing', () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);

      expect(() => interceptor.intercept(buildRpcExecutionContext(undefined), buildCallHandler())).toThrow(
        UnauthorizedException,
      );
    });

    describe('base64 validation', () => {
      it('throws BadRequestException with a base64-specific message when the value contains non-base64 characters', () => {
        const auditContext = buildMockAuditContext();
        const interceptor = buildInterceptor(auditContext);
        // `!` and `$` are not in the standard base64 character set.
        const metadata = buildMetadata({ [BGE_ACTOR_HEADER]: 'not!valid$base64' });

        expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
          new BadRequestException(`'${BGE_ACTOR_HEADER}' is not valid base64`),
        );
        expect(auditContext.runWith).not.toHaveBeenCalled();
      });

      it('throws BadRequestException for URL-safe base64 (the outbound interceptor produces standard base64 only)', () => {
        const auditContext = buildMockAuditContext();
        const interceptor = buildInterceptor(auditContext);
        // URL-safe base64 substitutes `-` for `+` and `_` for `/`. The
        // standard-only pattern rejects it.
        const metadata = buildMetadata({ [BGE_ACTOR_HEADER]: 'YWJj_def-' });

        expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
          new BadRequestException(`'${BGE_ACTOR_HEADER}' is not valid base64`),
        );
      });

      it('throws BadRequestException when the length is not a multiple of 4', () => {
        const auditContext = buildMockAuditContext();
        const interceptor = buildInterceptor(auditContext);
        // Three characters, no padding — invalid standard base64.
        const metadata = buildMetadata({ [BGE_ACTOR_HEADER]: 'abc' });

        expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
          new BadRequestException(`'${BGE_ACTOR_HEADER}' is not valid base64`),
        );
      });

      it('throws BadRequestException when padding is malformed', () => {
        const auditContext = buildMockAuditContext();
        const interceptor = buildInterceptor(auditContext);
        // Padding character `=` in the middle is invalid.
        const metadata = buildMetadata({ [BGE_ACTOR_HEADER]: 'ab=cdefg' });

        expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
          new BadRequestException(`'${BGE_ACTOR_HEADER}' is not valid base64`),
        );
      });
    });

    it('throws BadRequestException with a JSON-specific message when x-bge-actor is valid base64 of malformed JSON', () => {
      // Validates that the base64 path and the JSON path are distinguished
      // by the error message — useful when diagnosing whether the producer
      // is encoding incorrectly vs. emitting a non-JSON payload.
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);
      const garbage = Buffer.from('not-valid-json-{', 'utf8').toString('base64');
      const metadata = buildMetadata({ [BGE_ACTOR_HEADER]: garbage });

      expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
        BadRequestException,
      );
      expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
        /is not valid JSON/,
      );
    });

    it('throws BadRequestException when x-bge-actor is JSON but not an object', () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);
      const metadata = buildMetadata({
        [BGE_ACTOR_HEADER]: Buffer.from('"a-string"', 'utf8').toString('base64'),
      });

      expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for unknown actor kind', () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);
      const metadata = buildMetadata({
        [BGE_ACTOR_HEADER]: encodeActor({ kind: 'martian', userId: 'foo' }),
      });

      expect(() => interceptor.intercept(buildRpcExecutionContext(metadata), buildCallHandler())).toThrow(
        BadRequestException,
      );
    });
  });

  describe('@SkipActorContext exemption', () => {
    it('bypasses actor extraction and passes through to next.handle() for a marked handler', async () => {
      const auditContext = buildMockAuditContext();
      const reflector = buildReflector(true);
      const interceptor = buildInterceptor(auditContext, reflector);
      const next = buildCallHandler();
      // A health probe: no x-bge-actor metadata at all. Without the exemption
      // this would throw UnauthorizedException.
      const result = interceptor.intercept(buildRpcExecutionContext(buildMetadata()), next);
      await firstValueFrom(result);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(SKIP_ACTOR_CONTEXT_KEY, expect.any(Array));
      expect(auditContext.runWith).not.toHaveBeenCalled();
      expect(next.handle).toHaveBeenCalledTimes(1);
    });

    it('still enforces actor context for handlers that are NOT marked', () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext, buildReflector(false));

      expect(() => interceptor.intercept(buildRpcExecutionContext(buildMetadata()), buildCallHandler())).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('wrong execution context', () => {
    it('bails to next.handle() when the execution context is not rpc', async () => {
      const auditContext = buildMockAuditContext();
      const interceptor = buildInterceptor(auditContext);
      const next = buildCallHandler();
      const httpContext = {
        getType: () => 'http',
        switchToRpc: () => ({ getContext: () => undefined, getData: () => ({}) }),
        switchToHttp: () => ({}) as never,
        switchToWs: () => ({}) as never,
        getClass: () => ({}) as never,
        getHandler: () => ({}) as never,
        getArgs: () => [],
        getArgByIndex: () => undefined as never,
      } as unknown as ExecutionContext;

      const result = interceptor.intercept(httpContext, next);
      await firstValueFrom(result);

      // Surrogate's @NextPre bail short-circuits before our intercept body runs.
      expect(auditContext.runWith).not.toHaveBeenCalled();
      expect(next.handle).toHaveBeenCalledTimes(1);
    });
  });
});

describe('validateActorShape', () => {
  describe('user actor', () => {
    it('accepts a valid user actor', () => {
      expect(validateActorShape({ kind: 'user', userId: 'u-1' })).toEqual({
        kind: 'user',
        userId: 'u-1',
      });
    });

    it('strips extra fields from the input', () => {
      expect(validateActorShape({ kind: 'user', userId: 'u-1', extraField: 'ignored' })).toEqual({
        kind: 'user',
        userId: 'u-1',
      });
    });

    it('throws when userId is missing', () => {
      expect(() => validateActorShape({ kind: 'user' })).toThrow(BadRequestException);
    });

    it('throws when userId is not a string', () => {
      expect(() => validateActorShape({ kind: 'user', userId: 123 })).toThrow(BadRequestException);
    });
  });

  describe('anonymous actor', () => {
    it('accepts a valid anonymous actor', () => {
      const result = validateActorShape({ kind: 'anonymous', userId: 'anon-1' });
      expect(result).toEqual({ kind: 'anonymous', userId: 'anon-1' });
    });

    it('throws when userId is missing', () => {
      expect(() => validateActorShape({ kind: 'anonymous' })).toThrow(BadRequestException);
    });
  });

  describe('apiKey actor', () => {
    it('accepts a valid apiKey actor', () => {
      expect(validateActorShape({ kind: 'apiKey', apiKeyId: 'k-1', userId: 'u-1' })).toEqual({
        kind: 'apiKey',
        apiKeyId: 'k-1',
        userId: 'u-1',
      });
    });

    it('throws when apiKeyId is missing', () => {
      expect(() => validateActorShape({ kind: 'apiKey', userId: 'u-1' })).toThrow(BadRequestException);
    });

    it('throws when userId is missing', () => {
      expect(() => validateActorShape({ kind: 'apiKey', apiKeyId: 'k-1' })).toThrow(BadRequestException);
    });
  });

  describe('system actor', () => {
    it('accepts a valid system actor', () => {
      expect(validateActorShape({ kind: 'system', reason: 'scheduler' })).toEqual({
        kind: 'system',
        reason: 'scheduler',
      });
    });

    it('throws when reason is missing', () => {
      expect(() => validateActorShape({ kind: 'system' })).toThrow(BadRequestException);
    });
  });

  describe('external actor', () => {
    it('accepts a valid external actor', () => {
      expect(validateActorShape({ kind: 'external', system: 'gateway', identifier: 'g-1' })).toEqual({
        kind: 'external',
        system: 'gateway',
        identifier: 'g-1',
      });
    });

    it('throws when system is missing', () => {
      expect(() => validateActorShape({ kind: 'external', identifier: 'g-1' })).toThrow(BadRequestException);
    });

    it('throws when identifier is missing', () => {
      expect(() => validateActorShape({ kind: 'external', system: 'gateway' })).toThrow(BadRequestException);
    });
  });

  describe('plugin actor', () => {
    it('accepts a plugin actor with a user trigger', () => {
      const actor: Actor = {
        kind: 'plugin',
        pluginId: 'plugin-foo',
        trigger: { kind: 'user', userId: 'user-abc' },
      };
      expect(validateActorShape(actor)).toEqual(actor);
    });

    it('accepts a nested plugin actor (plugin invoked by plugin)', () => {
      const actor: Actor = {
        kind: 'plugin',
        pluginId: 'plugin-outer',
        trigger: {
          kind: 'plugin',
          pluginId: 'plugin-inner',
          trigger: { kind: 'system', reason: 'scheduler' },
        },
      };
      expect(validateActorShape(actor)).toEqual(actor);
    });

    it('throws when pluginId is missing', () => {
      expect(() =>
        validateActorShape({
          kind: 'plugin',
          trigger: { kind: 'user', userId: 'u-1' },
        }),
      ).toThrow(BadRequestException);
    });

    it('throws when trigger is missing', () => {
      expect(() => validateActorShape({ kind: 'plugin', pluginId: 'p-1' })).toThrow(BadRequestException);
    });

    it('throws when trigger is structurally invalid', () => {
      expect(() =>
        validateActorShape({
          kind: 'plugin',
          pluginId: 'p-1',
          trigger: { kind: 'user' }, // missing userId
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('rejection cases', () => {
    it('throws when input is null', () => {
      expect(() => validateActorShape(null)).toThrow(BadRequestException);
    });

    it('throws when input is undefined', () => {
      expect(() => validateActorShape(undefined)).toThrow(BadRequestException);
    });

    it('throws when input is a primitive', () => {
      expect(() => validateActorShape('a-string')).toThrow(BadRequestException);
      expect(() => validateActorShape(42)).toThrow(BadRequestException);
      expect(() => validateActorShape(true)).toThrow(BadRequestException);
    });

    it('throws when kind is missing', () => {
      expect(() => validateActorShape({ userId: 'u-1' })).toThrow(BadRequestException);
    });

    it('throws when kind is not a string', () => {
      expect(() => validateActorShape({ kind: 42, userId: 'u-1' })).toThrow(BadRequestException);
    });

    it('throws on an unknown kind', () => {
      expect(() => validateActorShape({ kind: 'invalid-kind', userId: 'u-1' })).toThrow(BadRequestException);
    });
  });
});
