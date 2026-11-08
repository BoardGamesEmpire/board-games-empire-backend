import { AuditContextModule } from '@bge/actor-context';
import { MailFailureCode } from '@bge/mail';
import type { JobMetaEnvelope } from '@bge/queue-actor-context';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import { ClsModule } from 'nestjs-cls';
import { MAIL_DELIVERY_ATTEMPTS, RESET_LINK_EXPIRED } from '../constants/mail-queue.constants';
import type { MailDeliveryJob } from '../interfaces/mail-delivery-job.interface';
import { MailDeliveryProcessor } from './mail-delivery.processor';
import { MailDeliveryService } from './mail-delivery.service';
import { MailTransportError } from './mail-transport.error';

const LINK = 'https://bge.test/reset?token=secret-token';

const data: MailDeliveryJob = {
  recipientUserId: 'user-1',
  message: { kind: 'password-reset', link: LINK, lifetimeMinutes: 60, expiresAt: '2999-01-01T00:00:00.000Z' },
};

const makeJob = (over: { attempts?: number; attemptsMade?: number } = {}): Job<MailDeliveryJob & JobMetaEnvelope> =>
  ({
    id: 'job-7',
    data,
    opts: { attempts: over.attempts ?? MAIL_DELIVERY_ATTEMPTS },
    attemptsMade: over.attemptsMade ?? 1,
  }) as unknown as Job<MailDeliveryJob & JobMetaEnvelope>;

describe('MailDeliveryProcessor', () => {
  let processor: MailDeliveryProcessor;
  let delivery: { deliver: jest.Mock };
  let logged: jest.SpyInstance[];

  beforeEach(async () => {
    delivery = { deliver: jest.fn().mockResolvedValue(undefined) };
    logged = (['log', 'debug', 'warn', 'error', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );

    const module = await Test.createTestingModule({
      // The worker host base class injects the audit context as a property.
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } }), AuditContextModule],
      providers: [MailDeliveryProcessor, { provide: MailDeliveryService, useValue: delivery }],
    }).compile();

    processor = module.get(MailDeliveryProcessor);
  });

  afterEach(() => jest.restoreAllMocks());

  const loggedArgs = () => logged.flatMap((spy) => spy.mock.calls).flat();
  const everythingLogged = () => JSON.stringify(loggedArgs());

  it('delivers the job through the service (#654)', async () => {
    await (processor as unknown as { processJob(job: Job): Promise<void> }).processJob(makeJob() as Job);

    expect(delivery.deliver).toHaveBeenCalledWith(data);
  });

  it('logs only the job id and the code for a terminal reset failure, never the link (#654)', async () => {
    const failure = new UnrecoverableError('MAIL_NOT_CONFIGURED');

    await processor.onFailed(makeJob({ attemptsMade: 1 }), failure);

    expect(everythingLogged()).toContain('job-7');
    expect(everythingLogged()).toContain('MAIL_NOT_CONFIGURED');
    expect(everythingLogged()).not.toContain(LINK);
    expect(everythingLogged()).not.toContain('secret-token');
    expect(loggedArgs()).not.toContain(failure);
    expect(loggedArgs().filter((arg) => typeof arg === 'object' && arg !== null)).toEqual([]);
  });

  it('logs the code of a permanent SMTP refusal, which fails for good (#654)', async () => {
    await processor.onFailed(makeJob({ attemptsMade: 1 }), new UnrecoverableError('MAIL_AUTH_FAILED'));

    expect(everythingLogged()).toContain('code=MAIL_AUTH_FAILED');
  });

  it('logs the code of a wrapped transport failure when the retries run out (#654)', async () => {
    await processor.onFailed(
      makeJob({ attempts: 5, attemptsMade: 5 }),
      new MailTransportError(MailFailureCode.AuthFailed),
    );

    expect(everythingLogged()).toContain('job-7');
    expect(everythingLogged()).toContain('MAIL_AUTH_FAILED');
    expect(everythingLogged()).not.toContain(LINK);
  });

  it('logs the id and code of a transport failure while retries remain (#654)', async () => {
    await processor.onFailed(
      makeJob({ attempts: 5, attemptsMade: 2 }),
      new MailTransportError(MailFailureCode.HostUnreachable),
    );

    expect(everythingLogged()).toContain('job-7');
    expect(everythingLogged()).toContain('MAIL_HOST_UNREACHABLE');
    expect(everythingLogged()).not.toContain(LINK);
  });

  it('names any other error by class and never claims a mail code or logs its message (#654)', async () => {
    const failure = new TypeError(`cannot read properties of ${LINK}`);

    await processor.onFailed(makeJob({ attempts: 5, attemptsMade: 5 }), failure);

    expect(everythingLogged()).toContain('job-7');
    expect(everythingLogged()).toContain('TypeError');
    expect(everythingLogged()).not.toContain('MAIL_');
    expect(everythingLogged()).not.toContain(LINK);
    expect(everythingLogged()).not.toContain('secret-token');
    expect(loggedArgs().filter((arg) => typeof arg === 'object' && arg !== null)).toEqual([]);
  });

  it('keeps the message of the base host`s own unrecoverable rejection, which holds no job data (#654)', async () => {
    const failure = new UnrecoverableError('Job mail-delivery#job-7 missing __meta envelope');

    await processor.onFailed(makeJob({ attemptsMade: 1 }), failure);

    expect(everythingLogged()).toContain('Job mail-delivery#job-7 missing __meta envelope');
    expect(everythingLogged()).not.toContain('MAIL_');
  });

  it('logs a reset dropped for an expired link as failed for good, naming the reason (#654)', async () => {
    await processor.onFailed(makeJob({ attemptsMade: 1 }), new UnrecoverableError(RESET_LINK_EXPIRED));

    expect(everythingLogged()).toContain('failed for good: reason=PASSWORD_RESET_LINK_EXPIRED');
    expect(everythingLogged()).not.toContain(LINK);
  });
});
