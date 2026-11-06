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
  message: { kind: 'password-reset', link: 'https://bge.test/reset?token=abc', lifetimeMinutes: 60 },
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
