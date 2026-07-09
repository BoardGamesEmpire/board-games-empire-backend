import type { AuditContextService } from '@bge/actor-context';
import { AuditExclude, Auditable, MutationEvent } from '@bge/actor-context';
import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { UNATTRIBUTED_ACTOR } from '../constants/audit-log.constants';
import type { AuditLogService } from './audit-log.service';
import { AuditPersistenceListener } from './audit-persistence.listener';
import type { AuditUnattributedNotifierService } from './audit-unattributed-notifier.service';

interface SamplePayload {
  id: string;
  title: string;
  passwordHash: string;
}

abstract class SampleEvent extends MutationEvent<SamplePayload> {
  readonly subject = 'Sample';
  readonly subjectId: string;

  constructor(
    before: Readonly<Partial<SamplePayload>> | null,
    after: Readonly<Partial<SamplePayload>> | null,
    initiatedAt = new Date(),
  ) {
    super(before, after, initiatedAt);
    this.subjectId = (after ?? before)?.id ?? 'sample-unknown';
  }
}

// Undecorated on purpose: opt-out semantics must persist it.
class UndecoratedEvent extends SampleEvent {}

@Auditable(false)
class OptedOutEvent extends SampleEvent {}

@AuditExclude(['passwordHash'])
class RedactedEvent extends SampleEvent {}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AuditPersistenceListener', () => {
  let emitter: jest.Mocked<Pick<EventEmitter2, 'onAny' | 'offAny'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor' | 'getSource' | 'getCorrelationId'>>;
  let auditLog: jest.Mocked<Pick<AuditLogService, 'record'>>;
  let notifier: jest.Mocked<Pick<AuditUnattributedNotifierService, 'notify'>>;
  let listener: AuditPersistenceListener;
  let anyListener: (event: string | string[], payload: unknown) => void;

  beforeEach(() => {
    emitter = { onAny: jest.fn(), offAny: jest.fn() };
    auditContext = {
      getActor: jest.fn().mockReturnValue({ kind: 'user', userId: 'u1' }),
      getSource: jest.fn().mockReturnValue('http'),
      getCorrelationId: jest.fn().mockReturnValue('corr-1'),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };

    listener = new AuditPersistenceListener(
      emitter as unknown as EventEmitter2,
      new Reflector(),
      auditContext as unknown as AuditContextService,
      auditLog as unknown as AuditLogService,
      notifier as unknown as AuditUnattributedNotifierService,
    );

    listener.onModuleInit();
    anyListener = emitter.onAny.mock.calls[0][0] as typeof anyListener;
  });

  it('registers on init and unregisters the same handler on destroy', () => {
    expect(emitter.onAny).toHaveBeenCalledTimes(1);

    listener.onModuleDestroy();

    expect(emitter.offAny).toHaveBeenCalledWith(anyListener);
  });

  it('ignores payloads that are not MutationEvents', async () => {
    anyListener('import.job.started', { jobId: 'j1' });
    await flush();

    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('persists undecorated MutationEvent subclasses (opt-out semantics)', async () => {
    const event = new UndecoratedEvent(null, { id: 's1', title: 'A' });

    anyListener('sample.created', event);
    await flush();

    expect(auditLog.record).toHaveBeenCalledWith({
      event: 'sample.created',
      actor: { kind: 'user', userId: 'u1' },
      action: 'create',
      subject: 'Sample',
      subjectId: 's1',
      source: 'http',
      correlationId: 'corr-1',
      before: null,
      after: { id: 's1', title: 'A' },
      initiatedAt: event.initiatedAt,
      occurredAt: event.occurredAt,
    });
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('skips events opted out with @Auditable(false)', async () => {
    anyListener('sample.noisy', new OptedOutEvent(null, { id: 's1' }));
    await flush();

    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('redacts @AuditExclude fields from both snapshots', async () => {
    const event = new RedactedEvent(
      { id: 's1', title: 'Old', passwordHash: 'old-hash' },
      { id: 's1', title: 'New', passwordHash: 'new-hash' },
    );

    anyListener('sample.updated', event);
    await flush();

    const entry = auditLog.record.mock.calls[0][0];
    expect(entry.action).toBe('update');
    expect(entry.before).toEqual({ id: 's1', title: 'Old' });
    expect(entry.after).toEqual({ id: 's1', title: 'New' });
  });

  it('falls back to the unattributed actor and notifies admins when CLS is empty', async () => {
    auditContext.getActor.mockReturnValue(null);
    auditContext.getSource.mockReturnValue(null);
    auditContext.getCorrelationId.mockReturnValue(null);

    anyListener('sample.created', new UndecoratedEvent(null, { id: 's1' }));
    await flush();

    const entry = auditLog.record.mock.calls[0][0];
    expect(entry.actor).toEqual(UNATTRIBUTED_ACTOR);
    expect(entry.source).toBeNull();
    expect(entry.correlationId).toBeNull();
    expect(notifier.notify).toHaveBeenCalledWith('sample.created', 'Sample', null);
  });

  it('does not notify when persistence fails (row must land first)', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    auditContext.getActor.mockReturnValue(null);
    auditLog.record.mockRejectedValue(new Error('db down'));

    anyListener('sample.created', new UndecoratedEvent(null, { id: 's1' }));
    await flush();

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('db down'));
    errorSpy.mockRestore();
  });

  it('swallows persistence failures instead of throwing into the emitter', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    auditLog.record.mockRejectedValue(new Error('insert failed'));

    expect(() => anyListener('sample.created', new UndecoratedEvent(null, { id: 's1' }))).not.toThrow();
    await flush();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sample.created'));
    errorSpy.mockRestore();
  });

  it('joins array event names with the delimiter', async () => {
    anyListener(['sample', 'created'], new UndecoratedEvent(null, { id: 's1' }));
    await flush();

    expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'sample.created' }));
  });
});
