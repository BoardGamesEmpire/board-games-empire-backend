import { NotificationType, SmtpSecurity } from '@bge/database';
import { LocaleResolutionService } from '@bge/i18n';
import { MAIL_SETTINGS_SELECT, MailFailureCode, mailFrom, smtpTransportOptions, type MailSettings } from '@bge/mail';
import { NotificationsService } from '@bge/notifications-service';
import { EncryptionService } from '@bge/services';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { I18nService } from 'nestjs-i18n';
import { createTransport } from 'nodemailer';
import { RESET_LINK_EXPIRED } from '../constants/mail-queue.constants';
import type { MailDeliveryJob } from '../interfaces/mail-delivery-job.interface';
import { MailDeliveryService } from './mail-delivery.service';
import { MailTransportError } from './mail-transport.error';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const SETTINGS: MailSettings = {
  name: 'Test Server',
  smtpHost: 'smtp.test',
  smtpPort: 587,
  smtpSecurity: SmtpSecurity.StartTls,
  smtpUser: 'mailer',
  smtpPassword: 'cipher',
  mailFromAddress: 'bge@test.example',
};

const RESET: MailDeliveryJob = {
  recipientUserId: 'user-1',
  message: {
    kind: 'password-reset',
    link: 'https://bge.test/reset?token=abc',
    lifetimeMinutes: 60,
    expiresAt: '2999-01-01T00:00:00.000Z',
  },
};
const TEST: MailDeliveryJob = { recipientUserId: 'admin-1', message: { kind: 'test' } };

describe('MailDeliveryService', () => {
  let service: MailDeliveryService;
  let db: MockDatabaseService;
  let sendMail: jest.Mock;
  let close: jest.Mock;
  let encryption: { decrypt: jest.Mock };
  let locale: { resolve: jest.Mock };
  let i18n: { translate: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    sendMail = jest.fn().mockResolvedValue({});
    close = jest.fn();
    (createTransport as jest.Mock).mockReturnValue({ sendMail, close });
    encryption = { decrypt: jest.fn().mockReturnValue('plain-pw') };
    locale = { resolve: jest.fn().mockResolvedValue('en') };
    i18n = { translate: jest.fn((key: string) => `[${key}]`) };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        MailDeliveryService,
        { provide: EncryptionService, useValue: encryption },
        { provide: LocaleResolutionService, useValue: locale },
        { provide: I18nService, useValue: i18n },
        { provide: NotificationsService, useValue: notifications },
      ],
    });

    service = module.get(MailDeliveryService);
    db = mockDb;
    db.systemSetting.findUnique.mockResolvedValue(SETTINGS as never);
    db.user.findUnique.mockResolvedValue({ email: 'sam@example.test', username: 'sam' } as never);
  });

  afterEach(() => jest.clearAllMocks());

  describe('the normal path', () => {
    it('reads the settings row on every call, so a change reaches the next job (#654)', async () => {
      await service.deliver(RESET);
      await service.deliver(RESET);

      expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(2);
      expect(db.systemSetting.findUnique).toHaveBeenCalledWith({
        where: { singleton: true },
        select: MAIL_SETTINGS_SELECT,
      });
    });

    // The transport is not pooled, so nodemailer connects for each send and
    // keeping one between jobs would save nothing (#654).
    it('builds a transport for each job and closes it after the send (#654)', async () => {
      await service.deliver(RESET);
      await service.deliver(RESET);

      expect(createTransport).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
    });

    it('decrypts the stored password for the transport (#654)', async () => {
      await service.deliver(RESET);

      expect(encryption.decrypt).toHaveBeenCalledWith('cipher');
      expect(createTransport).toHaveBeenCalledWith(smtpTransportOptions(SETTINGS, 'plain-pw'));
    });

    it('reads the recipient by id and renders in the language the locale service resolves (#654)', async () => {
      locale.resolve.mockResolvedValue('de');

      await service.deliver(RESET);

      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { email: true, username: true },
      });
      expect(locale.resolve).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(i18n.translate).toHaveBeenCalledWith(
        'mail.password_reset.subject',
        expect.objectContaining({ lang: 'de' }),
      );
    });

    it('sends plain text from the server name and From address, with no html (#654)', async () => {
      await service.deliver(RESET);

      expect(sendMail).toHaveBeenCalledTimes(1);
      const sent = sendMail.mock.calls[0][0];
      expect(sent).toEqual({
        from: mailFrom(SETTINGS),
        to: 'sam@example.test',
        subject: '[mail.password_reset.subject]',
        text: '[mail.password_reset.body]',
      });
      expect(sent).not.toHaveProperty('html');
    });

    it('does not decrypt when no password is stored (#654)', async () => {
      db.systemSetting.findUnique.mockResolvedValue({ ...SETTINGS, smtpPassword: null } as never);

      await service.deliver(RESET);

      expect(encryption.decrypt).not.toHaveBeenCalled();
      expect(createTransport).toHaveBeenCalledWith(smtpTransportOptions({ ...SETTINGS, smtpPassword: null }, null));
    });

    it('tells the admin a test email went, in a message the client renders in their language (#654)', async () => {
      await service.deliver(TEST);

      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'admin-1',
        type: NotificationType.MailTestResult,
        payload: expect.objectContaining({ outcome: 'sent', code: null }),
      });
      const message = notifications.create.mock.calls[0][0].payload.message;
      expect(JSON.stringify(message)).toContain('mail.test_result.sent');
    });

    it('creates no notification for a reset that went (#654)', async () => {
      await service.deliver(RESET);

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['settings are not configured', MailFailureCode.NotConfigured],
    ['the stored password cannot be decrypted', MailFailureCode.SettingsUnreadable],
  ])('when %s', (_name, code) => {
    beforeEach(() => {
      if (code === MailFailureCode.NotConfigured) {
        db.systemSetting.findUnique.mockResolvedValue({ ...SETTINGS, smtpHost: null } as never);
      } else {
        encryption.decrypt.mockImplementation(() => {
          throw new Error('Failed to decrypt data');
        });
      }
    });

    it('fails a reset for good, with the code as the message (#654)', async () => {
      const failure = service.deliver(RESET);

      await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(failure).rejects.toThrow(code);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('tells the admin about a test and resolves (#654)', async () => {
      await expect(service.deliver(TEST)).resolves.toBeUndefined();

      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'admin-1',
        type: NotificationType.MailTestResult,
        payload: expect.objectContaining({ outcome: 'failed', code }),
      });
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  // A reset that waited in the queue past its token's expiry, as while the
  // worker was down, would mail a dead link that says it still works (#654).
  describe('when a reset link expired in the queue', () => {
    const EXPIRES = '2026-11-06T12:00:00.000Z';
    const expiring: MailDeliveryJob = { ...RESET, message: { ...RESET.message, expiresAt: EXPIRES } as never };

    afterEach(() => jest.restoreAllMocks());

    it.each([
      ['at its expiry', 0],
      ['after it', 60_000],
    ])('drops it unsent %s, for good, on any attempt (#654)', async (_name, late) => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse(EXPIRES) + late);

      const failure = service.deliver(expiring);

      await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(failure).rejects.toThrow(RESET_LINK_EXPIRED);
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('sends it while the link still works (#654)', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse(EXPIRES) - 1);

      await expect(service.deliver(expiring)).resolves.toBeUndefined();

      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the SMTP server refuses', () => {
    beforeEach(() => {
      sendMail.mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
    });

    it('throws a retryable transport error with the code for a reset, so BullMQ retries (#654)', async () => {
      const failure = service.deliver(RESET);

      await expect(failure).rejects.toBeInstanceOf(MailTransportError);
      await expect(failure).rejects.not.toBeInstanceOf(UnrecoverableError);
      await expect(failure).rejects.toMatchObject({ code: MailFailureCode.AuthFailed });
      await expect(failure).rejects.not.toThrow('Invalid login');
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('closes the transport after a failed send (#654)', async () => {
      await service.deliver(RESET).catch(() => undefined);

      expect(close).toHaveBeenCalledTimes(1);
    });

    // A 5xx answer is SMTP's permanent refusal: another try gets the same
    // answer, and logging in wrong again and again can lock the account at
    // the provider (#654).
    it.each([
      ['bad credentials', 'EAUTH', 535, MailFailureCode.AuthFailed],
      ['an unknown recipient', 'EENVELOPE', 550, MailFailureCode.Rejected],
    ])(
      'fails a reset for good on %s (a %s %s), with the code as the message (#654)',
      async (_name, code, responseCode, mailCode) => {
        sendMail.mockRejectedValue(Object.assign(new Error('refused'), { code, responseCode }));

        const failure = service.deliver(RESET);

        await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
        await expect(failure).rejects.toThrow(mailCode);
      },
    );

    // A 4xx answer is temporary, as with greylisting, and a later try can pass.
    it.each([
      ['a greylisted recipient', 'EENVELOPE', 451],
      ['a temporary auth failure', 'EAUTH', 454],
    ])('retries a reset after %s (a %s %s) (#654)', async (_name, code, responseCode) => {
      sendMail.mockRejectedValue(Object.assign(new Error('try later'), { code, responseCode }));

      await expect(service.deliver(RESET)).rejects.toBeInstanceOf(MailTransportError);
    });

    it('tells the admin the code for a test and resolves (#654)', async () => {
      await expect(service.deliver(TEST)).resolves.toBeUndefined();

      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'admin-1',
        type: NotificationType.MailTestResult,
        payload: expect.objectContaining({ outcome: 'failed', code: MailFailureCode.AuthFailed }),
      });
    });
  });

  // A test has one try and the admin waits on its notification, so a failure
  // the send does not classify must still end in one (#654).
  describe('when something other than the send fails', () => {
    const outage = new Error('Timed out fetching a new connection from the connection pool');

    it.each([
      ['the recipient read', () => db.user.findUnique.mockRejectedValue(outage)],
      ['the settings read', () => db.systemSetting.findUnique.mockRejectedValue(outage)],
    ])('tells the admin a test was not sent when %s fails, and resolves (#654)', async (_step, arrange) => {
      arrange();

      await expect(service.deliver(TEST)).resolves.toBeUndefined();

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'admin-1',
        type: NotificationType.MailTestResult,
        payload: expect.objectContaining({ outcome: 'failed', code: MailFailureCode.SendFailed }),
      });
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('logs the class of what failed for a test, never its message (#654)', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      db.systemSetting.findUnique.mockRejectedValue(new TypeError('detail from https://c.example/reset#token=tok'));

      await service.deliver(TEST);

      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain(MailFailureCode.SendFailed);
      expect(line).toContain('TypeError');
      expect(line).not.toContain('c.example');
      warn.mockRestore();
    });

    it('rethrows it unchanged for a reset, so BullMQ retries (#654)', async () => {
      db.systemSetting.findUnique.mockRejectedValue(outage);

      await expect(service.deliver(RESET)).rejects.toBe(outage);

      expect(notifications.create).not.toHaveBeenCalled();
    });

    // The outcome is known before the one notification is written, so a test
    // that went is never reported as failed (#654).
    it('fails the job, reporting nothing else, when a sent test cannot be notified (#654)', async () => {
      notifications.create.mockRejectedValue(outage);

      await expect(service.deliver(TEST)).rejects.toBe(outage);

      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ outcome: 'sent' }) }),
      );
    });
  });

  it.each([
    ['test', TEST],
    ['password reset', RESET],
  ])('logs a %s send failure with only the step facts, never its text (#654)', async (_kind, job) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    sendMail.mockRejectedValue(
      Object.assign(new Error('refused for https://c.example/reset#token=tok'), {
        code: 'EAUTH',
        responseCode: 535,
        command: 'AUTH PLAIN',
        response: '535 secret-ish text',
      }),
    );

    await service.deliver(job).catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    for (const wanted of ['MAIL_AUTH_FAILED', 'EAUTH', '535', 'AUTH PLAIN', job.message.kind]) {
      expect(line).toContain(wanted);
    }
    for (const forbidden of ['secret-ish', 'tok', 'c.example', 'sam@example.test']) {
      expect(line).not.toContain(forbidden);
    }
    warn.mockRestore();
  });

  it.each([
    ['test', TEST],
    ['password reset', RESET],
  ])('resolves without sending or notifying when the recipient of a %s is gone (#654)', async (_kind, job) => {
    db.user.findUnique.mockResolvedValue(null);

    // Resolving, not throwing, so BullMQ completes the job with no retry.
    await expect(service.deliver(job)).resolves.toBeUndefined();

    expect(sendMail).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
