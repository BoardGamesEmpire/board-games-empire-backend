import { AuditContextService } from '@bge/actor-context';
import { JOB_META_KEY } from '@bge/queue-actor-context';
import type { Queue } from 'bullmq';
import {
  MAIL_DELIVERY_ATTEMPTS,
  MAIL_DELIVERY_BACKOFF_MS,
  MAIL_DELIVERY_JOB,
  MAIL_TEST_ATTEMPTS,
} from '../constants/mail-queue.constants';
import { MailDispatcherService } from './mail-dispatcher.service';
import { MailQueueUnavailableError } from './mail-queue-unavailable.error';

describe('MailDispatcherService', () => {
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor' | 'getCorrelationId'>>;
  let queue: jest.Mocked<Pick<Queue, 'add'>> & { opts?: { connection: { status: string } } };
  let service: MailDispatcherService;

  beforeEach(() => {
    auditContext = {
      getActor: jest.fn().mockReturnValue({ kind: 'user', userId: 'admin-1' }),
      getCorrelationId: jest.fn().mockReturnValue('corr-1'),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new MailDispatcherService(auditContext as unknown as AuditContextService, queue as unknown as Queue);
  });

  afterEach(() => jest.clearAllMocks());

  it('adds a password reset with five attempts, exponential backoff and no retained job (#654)', async () => {
    await service.enqueue('user-1', { kind: 'password-reset', link: 'https://bge.test/r?t=x', lifetimeMinutes: 60 });

    expect(queue.add).toHaveBeenCalledWith(MAIL_DELIVERY_JOB, expect.anything(), {
      attempts: MAIL_DELIVERY_ATTEMPTS,
      backoff: { type: 'exponential', delay: MAIL_DELIVERY_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(MAIL_DELIVERY_ATTEMPTS).toBe(5);
    expect(MAIL_DELIVERY_BACKOFF_MS).toBe(5000);
  });

  it('adds a test email with one attempt, so the admin hears back at once (#654)', async () => {
    await service.enqueue('admin-1', { kind: 'test' });

    expect(queue.add).toHaveBeenCalledWith(MAIL_DELIVERY_JOB, expect.anything(), {
      attempts: MAIL_TEST_ATTEMPTS,
      backoff: { type: 'exponential', delay: MAIL_DELIVERY_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(MAIL_TEST_ATTEMPTS).toBe(1);
  });

  it('wraps the payload with the CLS actor and correlation id (#654)', async () => {
    await service.enqueue('user-1', { kind: 'test' });

    const data = queue.add.mock.calls[0][1];
    expect(data).toMatchObject({ recipientUserId: 'user-1', message: { kind: 'test' } });
    expect(data[JOB_META_KEY]).toEqual({ actor: { kind: 'user', userId: 'admin-1' }, correlationId: 'corr-1' });
  });

  it('falls back to an unattributed system actor when the request has none (#654)', async () => {
    auditContext.getActor.mockReturnValue(null);
    auditContext.getCorrelationId.mockReturnValue(null);

    await service.enqueue('user-1', { kind: 'test' });

    const meta = queue.add.mock.calls[0][1][JOB_META_KEY];
    expect(meta.actor).toEqual({ kind: 'system', reason: 'mail:unattributed' });
    expect(typeof meta.correlationId).toBe('string');
  });

  it('throws whatever the queue throws, for the caller to decide (#654)', async () => {
    queue.add.mockRejectedValue(new Error('redis down'));

    await expect(service.enqueue('user-1', { kind: 'test' })).rejects.toThrow('redis down');
  });

  it('adds while the queue connection is ready (#654)', async () => {
    queue.opts = { connection: { status: 'ready' } };

    await service.enqueue('user-1', { kind: 'test' });

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  // The queue client holds a command while Redis is down, so an add would
  // hang the caller and keep a reset link in memory until Redis returns.
  it.each(['connecting', 'reconnecting', 'end'])(
    'throws MailQueueUnavailableError at once, adding nothing, while the connection is %s (#654)',
    async (status) => {
      queue.opts = { connection: { status } };

      await expect(service.enqueue('user-1', { kind: 'test' })).rejects.toBeInstanceOf(MailQueueUnavailableError);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );
});
