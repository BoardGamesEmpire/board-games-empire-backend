import { Reflector } from '@nestjs/core';
import { AuditExclude, Auditable, MutationEvent } from './mutation-event';

interface SamplePayload {
  id: string;
  title: string;
  passwordHash: string;
  secretKey: string;
}

@Auditable()
class CreatedEvent extends MutationEvent<SamplePayload> {}

@Auditable(false)
class OptedOutEvent extends MutationEvent<SamplePayload> {}

class UndecoratedEvent extends MutationEvent<SamplePayload> {}

@Auditable()
@AuditExclude(['passwordHash', 'secretKey'])
class WithDenylistEvent extends MutationEvent<SamplePayload> {}

describe('@Auditable', () => {
  const reflector = new Reflector();

  it('marks the class as auditable by default', () => {
    expect(reflector.get(Auditable, CreatedEvent)).toBe(true);
  });

  it('reads via instance.constructor', () => {
    const event = new CreatedEvent(null, { id: 'g1' });
    expect(reflector.get(Auditable, event.constructor)).toBe(true);
  });

  it('respects @Auditable(false)', () => {
    expect(reflector.get(Auditable, OptedOutEvent)).toBe(false);
  });

  it('returns undefined for undecorated event classes', () => {
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
    const event = new WithDenylistEvent(null, {
      id: 'g1',
      passwordHash: 'hash',
    });
    expect(reflector.get(AuditExclude, event.constructor)).toEqual(['passwordHash', 'secretKey']);
  });
});

describe('MutationEvent', () => {
  it('exposes before/after as readonly partials', () => {
    const event = new CreatedEvent(null, { id: 'g1', title: 'Catan' });

    expect(event.before).toBeNull();
    expect(event.after).toEqual({ id: 'g1', title: 'Catan' });
  });

  it('supports delete shape (after = null)', () => {
    const event = new CreatedEvent({ id: 'g1', title: 'Catan' }, null);

    expect(event.before).toEqual({ id: 'g1', title: 'Catan' });
    expect(event.after).toBeNull();
  });

  it('does not expose actor or meta on the event itself', () => {
    const event = new CreatedEvent(null, { id: 'g1' }) as MutationEvent<SamplePayload> & {
      actor?: unknown;
      meta?: unknown;
    };

    // Intentionally absent: CLS is the source of truth at handle time.
    expect(event.actor).toBeUndefined();
    expect(event.meta).toBeUndefined();
  });
});
