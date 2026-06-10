import type { Actor } from '@bge/actor-context';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { BGE_OTEL_ATTRIBUTES } from '../constants/otel-attributes.constants';
import type { ActorContextProvider, ActorSpanContext } from './actor-context-provider';
import { ActorSpanProcessor } from './actor-span.processor';

type SpanLike = Pick<Span, 'setAttribute'>;

describe('ActorSpanProcessor', () => {
  const emptyContext = {} as Context;

  const createMockSpan = (): jest.Mocked<SpanLike> => ({
    setAttribute: jest.fn().mockReturnThis(),
  });

  const buildProcessor = (snapshot: ActorSpanContext): ActorSpanProcessor => {
    const provider: ActorContextProvider = () => snapshot;
    return new ActorSpanProcessor(provider);
  };

  describe('onStart — empty snapshot', () => {
    it('sets no attributes when the provider returns an empty snapshot', () => {
      const span = createMockSpan();
      const processor = buildProcessor({});

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });

  describe('onStart — user actor', () => {
    it('sets only actor.kind (userId is PII and never propagated)', () => {
      const span = createMockSpan();
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_KIND, 'user');
      expect(span.setAttribute).toHaveBeenCalledTimes(1);
    });

    it('never stamps userId on the span under any key', () => {
      const span = createMockSpan();
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      const allArgs = span.setAttribute.mock.calls.flat();
      expect(allArgs).not.toContain('user-abc');
    });
  });

  describe('onStart — anonymous actor', () => {
    it('sets only actor.kind for anonymous BetterAuth sessions', () => {
      const span = createMockSpan();
      // BetterAuth anonymous plugin still issues a userId; it remains PII.
      const actor = { kind: 'anonymous', userId: 'anon-abc' } as unknown as Actor;
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_KIND, 'anonymous');
      expect(span.setAttribute).toHaveBeenCalledTimes(1);
      expect(span.setAttribute.mock.calls.flat()).not.toContain('anon-abc');
    });
  });

  describe('onStart — apiKey actor', () => {
    it('sets only actor.kind (neither apiKeyId nor userId propagate)', () => {
      const span = createMockSpan();
      const actor: Actor = { kind: 'apiKey', apiKeyId: 'key-xyz', userId: 'user-abc' };
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_KIND, 'apiKey');
      expect(span.setAttribute).toHaveBeenCalledTimes(1);

      const allArgs = span.setAttribute.mock.calls.flat();
      expect(allArgs).not.toContain('key-xyz');
      expect(allArgs).not.toContain('user-abc');
    });
  });

  describe('onStart — system actor', () => {
    it('sets only actor.kind (reason is debug metadata, not propagated to spans)', () => {
      const span = createMockSpan();
      const actor: Actor = { kind: 'system', reason: 'scheduled-task-cleanup' };
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_KIND, 'system');
      expect(span.setAttribute).toHaveBeenCalledTimes(1);
      expect(span.setAttribute.mock.calls.flat()).not.toContain('scheduled-task-cleanup');
    });
  });

  describe('onStart — external actor', () => {
    it('sets actor.kind and external_system (identifier withheld as potential PII)', () => {
      const span = createMockSpan();
      const actor: Actor = {
        kind: 'external',
        system: 'gateway',
        identifier: 'gateway-bgg-instance-1',
      };
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_KIND, 'external');
      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_EXTERNAL_SYSTEM, 'gateway');
      expect(span.setAttribute).toHaveBeenCalledTimes(2);
      expect(span.setAttribute.mock.calls.flat()).not.toContain('gateway-bgg-instance-1');
    });
  });

  describe('onStart — plugin actor', () => {
    it('sets actor.kind, plugin_id, and trigger_kind', () => {
      const span = createMockSpan();
      const actor: Actor = {
        kind: 'plugin',
        pluginId: 'plugin-foo',
        trigger: { kind: 'user', userId: 'user-abc' },
      };
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_KIND, 'plugin');
      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_PLUGIN_ID, 'plugin-foo');
      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_TRIGGER_KIND, 'user');
      expect(span.setAttribute).toHaveBeenCalledTimes(3);
    });

    it('exposes the immediate trigger kind for nested plugin actors (one hop deep)', () => {
      const span = createMockSpan();
      const actor: Actor = {
        kind: 'plugin',
        pluginId: 'plugin-outer',
        trigger: {
          kind: 'plugin',
          pluginId: 'plugin-inner',
          trigger: { kind: 'system', reason: 'scheduler' },
        },
      };
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      // Spans surface only the immediate trigger.kind — incident
      // investigation walks the full chain via the audit log if needed.
      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_TRIGGER_KIND, 'plugin');
      // Inner plugin's pluginId is never exposed on this span.
      expect(span.setAttribute.mock.calls.flat()).not.toContain('plugin-inner');
    });

    it('does not propagate the plugin trigger userId', () => {
      const span = createMockSpan();
      const actor: Actor = {
        kind: 'plugin',
        pluginId: 'plugin-foo',
        trigger: { kind: 'user', userId: 'user-abc' },
      };
      const processor = buildProcessor({ actor });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute.mock.calls.flat()).not.toContain('user-abc');
    });
  });

  describe('onStart — household + correlation', () => {
    it('stamps household.id when present', () => {
      const span = createMockSpan();
      const processor = buildProcessor({ householdId: 'hh-123' });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.HOUSEHOLD_ID, 'hh-123');
      expect(span.setAttribute).toHaveBeenCalledTimes(1);
    });

    it('stamps correlation_id when present', () => {
      const span = createMockSpan();
      const processor = buildProcessor({ correlationId: 'corr-xyz' });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.CORRELATION_ID, 'corr-xyz');
      expect(span.setAttribute).toHaveBeenCalledTimes(1);
    });

    it('stamps all three when actor + household + correlation are present', () => {
      const span = createMockSpan();
      const processor = buildProcessor({
        actor: { kind: 'user', userId: 'user-abc' },
        householdId: 'hh-123',
        correlationId: 'corr-xyz',
      });

      processor.onStart(span as unknown as Span, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.ACTOR_KIND, 'user');
      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.HOUSEHOLD_ID, 'hh-123');
      expect(span.setAttribute).toHaveBeenCalledWith(BGE_OTEL_ATTRIBUTES.CORRELATION_ID, 'corr-xyz');
      expect(span.setAttribute).toHaveBeenCalledTimes(3);
    });
  });

  describe('onStart — PII allow-list discipline', () => {
    it('emits ONLY attributes from the BGE_OTEL_ATTRIBUTES allow-list', () => {
      const span = createMockSpan();
      const actor: Actor = {
        kind: 'plugin',
        pluginId: 'plugin-foo',
        trigger: { kind: 'apiKey', apiKeyId: 'key-xyz', userId: 'user-abc' },
      };
      const processor = buildProcessor({
        actor,
        householdId: 'hh-123',
        correlationId: 'corr-xyz',
      });

      processor.onStart(span as unknown as Span, emptyContext);

      const allowList = new Set<string>(Object.values(BGE_OTEL_ATTRIBUTES));
      const stampedKeys = span.setAttribute.mock.calls.map(([key]) => key);
      for (const key of stampedKeys) {
        expect(allowList.has(key as string)).toBe(true);
      }
    });
  });

  describe('onStart — provider error isolation', () => {
    it('does not throw and stamps no attributes when the provider throws', () => {
      const span = createMockSpan();
      const provider: ActorContextProvider = () => {
        throw new Error('provider broke');
      };
      const processor = new ActorSpanProcessor(provider);

      expect(() => processor.onStart(span as unknown as Span, emptyContext)).not.toThrow();
      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle methods', () => {
    let processor: ActorSpanProcessor;

    beforeEach(() => {
      processor = buildProcessor({});
    });

    it('onEnd is a no-op', () => {
      const readableSpan = {} as ReadableSpan;
      expect(() => processor.onEnd(readableSpan)).not.toThrow();
    });

    it('shutdown resolves without error', async () => {
      await expect(processor.shutdown()).resolves.toBeUndefined();
    });

    it('forceFlush resolves without error', async () => {
      await expect(processor.forceFlush()).resolves.toBeUndefined();
    });
  });
});
