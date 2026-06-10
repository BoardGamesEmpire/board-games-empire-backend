/**
 * Integration spec verifying that CLS audit context (actor +
 * correlationId + source) AND OTel trace context both propagate through
 * the `@nestjs/event-emitter` `@OnEvent` boundary with no manual envelope.
 *
 * Why this test exists:
 *
 *   Other async boundaries in BGE (gRPC, BullMQ) require explicit
 *   propagation — bytes cross a process line, so context must be
 *   serialized and restored. EventEmitter2 is in-process and emits
 *   synchronously by default; the listener's first sync line executes
 *   inside the same AsyncLocalStorage scope as the emit() caller.
 *   Both nestjs-cls and OTel (when the global context manager is
 *   ALS-backed) rely on AsyncLocalStorage, so propagation is automatic.
 *
 *   This spec locks down that behavior. If a future change (a different
 *   emitter config, a custom dispatcher, a process-bridging adapter)
 *   breaks the chain, these tests fail before production does.
 *
 * What this spec does NOT cover:
 *
 *   - `emitter.emitAsync(...)` in combination with listeners registered
 *     `{ async: true }`. These two are incompatible by design — `async: true`
 *     schedules the handler via `process.nextTick`/microtask and returns
 *     `undefined` to EventEmitter2, so `emitAsync` has nothing to await.
 *     The BGE pattern is `emit()` + `{ async: true }` (fire-and-forget),
 *     which is what this spec exercises. If a future BGE caller ever needs
 *     `emitAsync` semantics, they must drop `{ async: true }` from the
 *     listener and the listener must return a real Promise.
 *   - Cross-process event re-emission (e.g., over Redis pub/sub) — not a
 *     BGE pattern; would need its own envelope and spec.
 *   - Detached timers spawned by a listener (e.g., `setInterval`
 *     scheduled with no captured scope) — handled by `SystemActorScope`
 *     if needed, not by EventEmitter2 itself.
 */

import { Injectable } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule, OnEvent } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { context, createContextKey } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ClsModule } from 'nestjs-cls';
import { AuditContextModule } from './audit-context.module';
import { AuditContextInternalService } from './services/audit-context-internal.service';
import { AuditContextService } from './services/audit-context.service';
import type { Actor, EventSource } from './types';

const TEST_TRACE_KEY = createContextKey('event-propagation-spec-marker');

interface CapturedSnapshot {
  readonly actor: Actor | null;
  readonly correlationId: string | null;
  readonly source: EventSource | null;
  readonly otelMarker: string | undefined;
}

/**
 * Listener under test. One `@OnEvent` handler per scenario so each test
 * inspects an independent capture without ordering coupling.
 */
@Injectable()
class PropagationListener {
  capturedSync: CapturedSnapshot | undefined;
  capturedAfterAwait: CapturedSnapshot | undefined;
  capturedHistory: CapturedSnapshot[] = [];

  constructor(private readonly audit: AuditContextService) {}

  @OnEvent('test.sync', { async: true })
  async onSync(): Promise<void> {
    this.capturedSync = this.snapshot();
    this.capturedHistory.push(this.snapshot());
  }

  @OnEvent('test.after-await', { async: true })
  async onAfterAwait(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.capturedAfterAwait = this.snapshot();
  }

  private snapshot(): CapturedSnapshot {
    return {
      actor: this.audit.getActor(),
      correlationId: this.audit.getCorrelationId(),
      source: this.audit.getSource(),
      otelMarker: context.active().getValue(TEST_TRACE_KEY) as string | undefined,
    };
  }
}

/**
 * Drains pending microtasks and one immediate cycle. Sufficient for the
 * shallow async chains in `PropagationListener`. Use this after `emit()`
 * (fire-and-forget) before asserting on captures.
 *
 * Two cycles cover the `{ async: true }` listener wrapper, which
 * schedules the handler via an additional tick before the handler body
 * runs.
 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe('EventEmitter2 context propagation (integration)', () => {
  let otelManager: AsyncLocalStorageContextManager;
  let module: TestingModule;
  let emitter: EventEmitter2;
  let listener: PropagationListener;
  let auditInternal: AuditContextInternalService;

  beforeAll(() => {
    // Install a real ALS-backed OTel context manager so `context.with`
    // actually propagates through async boundaries. Without this, OTel
    // uses a noop manager and the trace-context half of the spec would
    // pass trivially.
    otelManager = new AsyncLocalStorageContextManager();
    otelManager.enable();
    context.setGlobalContextManager(otelManager);
  });

  afterAll(() => {
    otelManager.disable();
    // Reset OTel's global to the default noop for any subsequent suites.
    context.disable();
  });

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        EventEmitterModule.forRoot(),
        AuditContextModule,
      ],
      providers: [PropagationListener],
    }).compile();

    // Triggers @OnEvent registration via @nestjs/event-emitter's
    // OnApplicationBootstrap hook.
    await module.init();

    emitter = module.get(EventEmitter2);
    listener = module.get(PropagationListener);
    auditInternal = module.get(AuditContextInternalService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('CLS audit context propagation', () => {
    it('listener sees the actor active at emit() time', async () => {
      const actor: Actor = { kind: 'user', userId: 'user-1' };

      auditInternal.runWith({ actor, correlationId: 'corr-1', source: 'http' }, () => {
        emitter.emit('test.sync', {});
      });
      await flushAsync();

      expect(listener.capturedSync).toEqual({
        actor,
        correlationId: 'corr-1',
        source: 'http',
        otelMarker: undefined,
      });
    });

    it('propagates correlationId and source alongside the actor', async () => {
      auditInternal.runWith(
        {
          actor: { kind: 'apiKey', apiKeyId: 'key-1', userId: 'user-1' },
          correlationId: 'corr-with-source',
          source: 'grpc',
        },
        () => {
          emitter.emit('test.sync', {});
        },
      );
      await flushAsync();

      expect(listener.capturedSync?.correlationId).toBe('corr-with-source');
      expect(listener.capturedSync?.source).toBe('grpc');
    });

    it('CLS state persists across an await inside the listener body', async () => {
      const actor: Actor = { kind: 'user', userId: 'user-await' };

      auditInternal.runWith({ actor, correlationId: 'corr-await', source: 'http' }, () => {
        emitter.emit('test.after-await', {});
      });
      // Give the listener time to resolve its awaits.
      await flushAsync();
      await flushAsync();

      expect(listener.capturedAfterAwait?.actor).toEqual(actor);
      expect(listener.capturedAfterAwait?.correlationId).toBe('corr-await');
    });

    it('successive emits do not bleed context between listener invocations', async () => {
      const actorA: Actor = { kind: 'user', userId: 'user-A' };
      const actorB: Actor = { kind: 'user', userId: 'user-B' };

      auditInternal.runWith({ actor: actorA, correlationId: 'a', source: 'http' }, () => {
        emitter.emit('test.sync', {});
      });
      auditInternal.runWith({ actor: actorB, correlationId: 'b', source: 'http' }, () => {
        emitter.emit('test.sync', {});
      });
      await flushAsync();

      expect(listener.capturedHistory).toHaveLength(2);
      expect(listener.capturedHistory[0]?.actor).toEqual(actorA);
      expect(listener.capturedHistory[0]?.correlationId).toBe('a');
      expect(listener.capturedHistory[1]?.actor).toEqual(actorB);
      expect(listener.capturedHistory[1]?.correlationId).toBe('b');
    });

    it('listener sees null when emit() is called outside any audit scope', async () => {
      emitter.emit('test.sync', {});
      await flushAsync();

      expect(listener.capturedSync).toEqual({
        actor: null,
        correlationId: null,
        source: null,
        otelMarker: undefined,
      });
    });
  });

  describe('OTel trace context propagation', () => {
    it('listener sees the OTel context active at emit() time', async () => {
      const ctxWithMarker = context.active().setValue(TEST_TRACE_KEY, 'marker-emit');

      await context.with(ctxWithMarker, async () => {
        emitter.emit('test.sync', {});
        await flushAsync();
      });

      expect(listener.capturedSync?.otelMarker).toBe('marker-emit');
    });

    it('OTel context persists across an await inside the listener body', async () => {
      const ctxWithMarker = context.active().setValue(TEST_TRACE_KEY, 'marker-await');

      await context.with(ctxWithMarker, async () => {
        emitter.emit('test.after-await', {});
        await flushAsync();
        await flushAsync();
      });

      expect(listener.capturedAfterAwait?.otelMarker).toBe('marker-await');
    });

    it('successive context.with scopes do not bleed between listener invocations', async () => {
      const ctxA = context.active().setValue(TEST_TRACE_KEY, 'marker-A');
      const ctxB = context.active().setValue(TEST_TRACE_KEY, 'marker-B');

      await context.with(ctxA, async () => {
        emitter.emit('test.sync', {});
        await flushAsync();
      });
      await context.with(ctxB, async () => {
        emitter.emit('test.sync', {});
        await flushAsync();
      });

      expect(listener.capturedHistory).toHaveLength(2);
      expect(listener.capturedHistory[0]?.otelMarker).toBe('marker-A');
      expect(listener.capturedHistory[1]?.otelMarker).toBe('marker-B');
    });
  });

  describe('audit context and OTel context together', () => {
    it('both contexts propagate simultaneously through the same emit', async () => {
      const actor: Actor = { kind: 'user', userId: 'user-combined' };
      const ctxWithMarker = context.active().setValue(TEST_TRACE_KEY, 'combined-marker');

      await context.with(ctxWithMarker, async () => {
        await auditInternal.runWith({ actor, correlationId: 'corr-combined', source: 'http' }, async () => {
          emitter.emit('test.sync', {});
          await flushAsync();
        });
      });

      expect(listener.capturedSync).toEqual({
        actor,
        correlationId: 'corr-combined',
        source: 'http',
        otelMarker: 'combined-marker',
      });
    });
  });
});
