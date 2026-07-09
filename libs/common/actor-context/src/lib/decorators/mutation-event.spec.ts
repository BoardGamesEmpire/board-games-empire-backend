import { Reflector } from '@nestjs/core';
import { AuditExclude, Auditable, MutationEvent } from './mutation-event';

interface SamplePayload {
  id: string;
  title: string;
  passwordHash: string;
  secretKey: string;
}

abstract class SampleEvent extends MutationEvent<SamplePayload> {
  readonly subject = 'Sample';
  readonly subjectId: string;

  constructor(
    before: Readonly<Partial<SamplePayload>> | null,
    after: Readonly<Partial<SamplePayload>> | null,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = (after ?? before)?.id ?? 'sample-unknown';
  }
}

@Auditable()
class CreatedEvent extends SampleEvent {}

@Auditable(false)
class OptedOutEvent extends SampleEvent {}

class UndecoratedEvent extends SampleEvent {}

@Auditable()
@AuditExclude(['passwordHash', 'secretKey'])
class WithDenylistEvent extends SampleEvent {}

describe('@Auditable', () => {
  const reflector = new Reflector();

  it('marks the class as auditable by default', () => {
    expect(reflector.get(Auditable, CreatedEvent)).toBe(true);
  });

  it('reads via instance.constructor', () => {
    const event = new CreatedEvent(null, { id: 'g1' }, new Date());
    expect(reflector.get(Auditable, event.constructor)).toBe(true);
  });

  it('respects @Auditable(false)', () => {
    expect(reflector.get(Auditable, OptedOutEvent)).toBe(false);
  });

  it('returns undefined for undecorated event classes', () => {
    // Audit semantics are opt-out: the listener persists unless the value is
    // exactly `false`, so an undecorated subclass is still audited.
    expect(reflector.get(Auditable, UndecoratedEvent)).toBeUndefined();
  });
});

describe('@AuditExclude', () => {
  const reflector = new Reflector();

  it('exposes the denylist on classes that declare one', () => {
    expect(reflector.get(AuditExclude, WithDenylistEvent)).toEqual(['passwordHash', 'secretKey']);
  });

  it('returns undefined when no denylist is declared', () => {
    expect(reflector.get(AuditExclude, CreatedEvent)).toBeUndefined();
  });

  it('reads via instance.constructor', () => {
    const event = new WithDenylistEvent(null, { id: 'g1', passwordHash: 'hash' }, new Date());
    expect(reflector.get(AuditExclude, event.constructor)).toEqual(['passwordHash', 'secretKey']);
  });
});

describe('MutationEvent', () => {
  it('exposes before/after as readonly partials', () => {
    const event = new CreatedEvent(null, { id: 'g1', title: 'Catan' }, new Date());

    expect(event.before).toBeNull();
    expect(event.after).toEqual({ id: 'g1', title: 'Catan' });
  });

  it('supports delete shape (after = null)', () => {
    const event = new CreatedEvent({ id: 'g1', title: 'Catan' }, null, new Date());

    expect(event.before).toEqual({ id: 'g1', title: 'Catan' });
    expect(event.after).toBeNull();
  });

  it('rejects construction with neither before nor after', () => {
    expect(() => new CreatedEvent(null, null, new Date())).toThrow(TypeError);
    expect(() => new CreatedEvent(null, null, new Date())).toThrow(/CreatedEvent requires at least one of before\/after/);
  });

  describe('subject identification', () => {
    it('exposes subject and subjectId', () => {
      const event = new CreatedEvent(null, { id: 'g1', title: 'Catan' }, new Date());

      expect(event.subject).toBe('Sample');
      expect(event.subjectId).toBe('g1');
    });

    it('resolves subjectId from before on delete shape', () => {
      const event = new CreatedEvent({ id: 'g9' }, null, new Date());

      expect(event.subjectId).toBe('g9');
    });
  });

  describe('action derivation', () => {
    it('derives create when before is null', () => {
      const event = new CreatedEvent(null, { id: 'g1' }, new Date());

      expect(event.action).toBe('create');
    });

    it('derives delete when after is null', () => {
      const event = new CreatedEvent({ id: 'g1' }, null, new Date());

      expect(event.action).toBe('delete');
    });

    it('derives update when both sides are present', () => {
      const event = new CreatedEvent({ id: 'g1', title: 'Catan' }, { id: 'g1', title: 'Catan 2e' }, new Date());

      expect(event.action).toBe('update');
    });
  });

  describe('initiatedAt', () => {
    it('stores the value supplied by the emitter', () => {
      const initiatedAt = new Date('2026-01-15T10:00:00.000Z');
      const event = new CreatedEvent(null, { id: 'g1' }, initiatedAt);

      expect(event.initiatedAt).toBe(initiatedAt);
    });
  });

  describe('occurredAt', () => {
    it('captures the moment of construction', () => {
      const before = Date.now();
      const event = new CreatedEvent(null, { id: 'g1' }, new Date(before));
      const after = Date.now();

      expect(event.occurredAt).toBeInstanceOf(Date);
      expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('assigns distinct occurredAt to events constructed at distinct times', async () => {
      const first = new CreatedEvent(null, { id: 'g1' }, new Date());
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = new CreatedEvent(null, { id: 'g2' }, new Date());

      expect(second.occurredAt.getTime()).toBeGreaterThan(first.occurredAt.getTime());
    });
  });

  describe('per-step duration semantics', () => {
    it('occurredAt is after initiatedAt for a step that takes time', async () => {
      // Simulate a step: capture start, do work, construct event at the end.
      const initiatedAt = new Date();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const event = new CreatedEvent(null, { id: 'g1' }, initiatedAt);

      const durationMs = event.occurredAt.getTime() - event.initiatedAt.getTime();
      expect(durationMs).toBeGreaterThanOrEqual(5);
    });

    it('initiatedAt and occurredAt are independent — emitter controls initiation', () => {
      // An emitter could supply an initiatedAt from before the test started
      // (e.g. captured at the start of a long-running step).
      const stepStart = new Date(Date.now() - 1_000);
      const event = new CreatedEvent(null, { id: 'g1' }, stepStart);

      expect(event.initiatedAt).toBe(stepStart);
      expect(event.occurredAt.getTime()).toBeGreaterThan(stepStart.getTime());
    });
  });

  it('does not expose actor or meta on the event itself', () => {
    const event = new CreatedEvent(null, { id: 'g1' }, new Date()) as MutationEvent<SamplePayload> & {
      actor?: unknown;
      meta?: unknown;
    };

    // Intentionally absent: CLS is the source of truth at handle time.
    expect(event.actor).toBeUndefined();
    expect(event.meta).toBeUndefined();
  });
});
