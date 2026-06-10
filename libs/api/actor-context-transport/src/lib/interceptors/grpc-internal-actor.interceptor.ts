/**
 * Populates CLS actor + correlation for inbound gRPC calls on TRUSTED
 * internal channels — i.e. calls between BGE services such as
 * api → coordinator.
 *
 * Trust model: the channel itself is the boundary (mTLS / network policy
 * in production, loopback in dev). The `x-bge-actor` metadata is read
 * verbatim and trusted — there is no signing or HMAC at this layer.
 * Receivers structurally validate but do not authenticate the payload
 * cryptographically. This intentionally mirrors the locked decision
 * (see issue #72): hardening the trust boundary lives at the network
 * layer, not in this interceptor.
 *
 * Contrast with {@link GrpcActorInterceptor}, which handles UNTRUSTED
 * inbound gRPC (the eventual gateway-into-api case): that mints a fresh
 * `external` actor from a gateway identifier. This interceptor reads a
 * pre-existing Actor from metadata and propagates it unchanged.
 *
 * Behaviour:
 * - Missing `x-bge-actor` → `UnauthorizedException`. On a trusted internal
 *   channel the absence of this header indicates a caller-side bug
 *   (likely a call made outside a CLS scope on the upstream service);
 *   "fail loudly" per the pre-alpha policy.
 * - Malformed payload (bad base64, bad JSON, unknown actor kind, missing
 *   required field) → `BadRequestException`. NestJS's gRPC exception
 *   filter maps these to appropriate gRPC status codes.
 * - Valid payload → fresh `Actor` constructed with only the canonical
 *   fields for the variant; extra JSON fields are dropped. CLS is
 *   populated via `auditContext.runWith` so the downstream handler sees
 *   the actor available via `AuditContextService.getActor()`.
 *
 * Opens its own CLS scope per call. The coordinator's CLS middleware is
 * mount: false (no HTTP entry point), so there is no outer scope to
 * inherit. `next.handle().subscribe(subscriber)` runs inside `runWith`
 * so AsyncLocalStorage propagates to async emissions downstream.
 */
import { type Actor, type ActorContextInit } from '@bge/actor-context';
import { BGE_ACTOR_HEADER, CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import { resolveCorrelationId } from '@bge/utils';
import type { Metadata } from '@grpc/grpc-js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ActorInterceptor } from './actor.interceptor';

@Injectable()
export class GrpcInternalActorInterceptor extends ActorInterceptor {
  protected readonly executionContextType = 'rpc';
  protected override readonly auditSource = 'grpc';

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rawContext = executionContext.switchToRpc().getContext<{ metadata?: Metadata } | Metadata>();
    const metadata = this.unwrap(rawContext);

    if (!metadata) {
      throw new UnauthorizedException(`gRPC call missing metadata; cannot resolve '${BGE_ACTOR_HEADER}'`);
    }

    const actor = this.extractActor(metadata);

    const init: ActorContextInit = {
      actor,
      correlationId: resolveCorrelationId({
        traceparent: this.firstMetadata(metadata, TRACEPARENT_HEADER),
        correlationId: this.firstMetadata(metadata, CORRELATION_ID_HEADER),
      }),
      source: this.source,
    };

    return new Observable<unknown>((subscriber) =>
      this.auditContext.runWith(init, () => next.handle().subscribe(subscriber)),
    );
  }

  /**
   * Extracts and structurally validates the `x-bge-actor` payload.
   * Throws `UnauthorizedException` if the header is missing,
   * `BadRequestException` if it is malformed.
   */
  private extractActor(metadata: Metadata): Actor {
    const raw = this.firstMetadata(metadata, BGE_ACTOR_HEADER);
    if (!raw) {
      throw new UnauthorizedException(`gRPC call missing '${BGE_ACTOR_HEADER}' metadata on internal channel`);
    }

    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch (error) {
      throw new BadRequestException(`'${BGE_ACTOR_HEADER}' is not valid base64: ${(error as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch (error) {
      throw new BadRequestException(`'${BGE_ACTOR_HEADER}' is not valid JSON: ${(error as Error).message}`);
    }

    return validateActorShape(parsed);
  }

  private unwrap(value: { metadata?: Metadata } | Metadata | undefined): Metadata | null {
    if (!value) {
      return null;
    }
    if ('metadata' in value && value.metadata) {
      return value.metadata;
    }
    if ('get' in value && typeof value.get === 'function') {
      return value as Metadata;
    }
    return null;
  }

  private firstMetadata(metadata: Metadata, key: string): string | undefined {
    const values = metadata.get(key);
    const first = values[0];

    if (typeof first === 'string') {
      return first;
    }
    if (first instanceof Buffer) {
      return first.toString('utf-8');
    }
    return undefined;
  }
}

/**
 * Structural validator for an incoming `Actor`. Returns a freshly
 * constructed Actor with ONLY the canonical fields for the variant —
 * any extra fields in the incoming JSON are silently dropped, giving
 * downstream code a stable shape. Recursive for plugin actors.
 *
 * Throws `BadRequestException` for any structural problem with a
 * message identifying the missing or wrong-typed field.
 *
 * Exported for unit testing; not part of the lib's public API barrel.
 */
export const validateActorShape = (value: unknown): Actor => {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestException('actor payload is not an object');
  }

  const obj = value as Record<string, unknown>;
  if (typeof obj?.kind !== 'string') {
    throw new BadRequestException('actor payload missing string "kind"');
  }

  switch (obj.kind) {
    case 'user': {
      const userId = obj['userId'];
      if (typeof userId !== 'string') {
        throw new BadRequestException('user actor: userId must be a string');
      }
      return { kind: 'user', userId };
    }

    case 'anonymous': {
      const userId = obj['userId'];
      if (typeof userId !== 'string') {
        throw new BadRequestException('anonymous actor: userId must be a string');
      }

      return { kind: 'anonymous', userId } as Actor;
    }

    case 'apiKey': {
      const apiKeyId = obj['apiKeyId'];
      if (typeof apiKeyId !== 'string') {
        throw new BadRequestException('apiKey actor: apiKeyId must be a string');
      }

      const userId = obj['userId'];
      if (typeof userId !== 'string') {
        throw new BadRequestException('apiKey actor: userId must be a string');
      }

      return { kind: 'apiKey', apiKeyId, userId };
    }

    case 'system': {
      const reason = obj['reason'];
      if (typeof reason !== 'string') {
        throw new BadRequestException('system actor: reason must be a string');
      }

      return { kind: 'system', reason };
    }

    case 'external': {
      const system = obj['system'];
      const identifier = obj['identifier'];
      if (typeof system !== 'string') {
        throw new BadRequestException('external actor: system must be a string');
      }

      if (typeof identifier !== 'string') {
        throw new BadRequestException('external actor: identifier must be a string');
      }

      return { kind: 'external', system, identifier };
    }

    case 'plugin': {
      const pluginId = obj['pluginId'];
      if (typeof pluginId !== 'string') {
        throw new BadRequestException('plugin actor: pluginId must be a string');
      }

      const trigger = validateActorShape(obj['trigger']);
      return { kind: 'plugin', pluginId, trigger };
    }

    default:
      throw new BadRequestException(`unknown actor kind: '${obj['kind']}'`);
  }
};
