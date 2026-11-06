import { DatabaseService, NotificationType } from '@bge/database';
import type { I18nTranslations } from '@bge/i18n';
import { LocaleResolutionService, t } from '@bge/i18n';
import {
  classifyMailError,
  isMailConfigured,
  MAIL_SETTINGS_SELECT,
  MailFailureCode,
  mailFrom,
  mailTestResultMessageKey,
  renderMail,
  smtpTransportOptions,
} from '@bge/mail';
import { NotificationsService } from '@bge/notifications-service';
import { EncryptionService } from '@bge/services';
import { Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { I18nService } from 'nestjs-i18n';
import { createTransport } from 'nodemailer';
import { RESET_LINK_EXPIRED } from '../constants/mail-queue.constants';
import type { MailDeliveryJob } from '../interfaces/mail-delivery-job.interface';
import { MailTransportError } from './mail-transport.error';

/** SMTP's permanent refusals (RFC 5321 4.2.1): sending again gets the same answer. */
function isPermanentRefusal(error: unknown): boolean {
  const { responseCode } = (error ?? {}) as { responseCode?: unknown };

  return typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600;
}

/**
 * The worker's sender (#654). For every job it reads the mail settings from
 * the row, decrypts the SMTP password, renders the message in the recipient's
 * language and sends it over a new transport. Nothing is kept across jobs, so
 * an admin's change applies to the next mail. The transport is not pooled, so
 * keeping it would save no connection: nodemailer connects for each send.
 *
 * Failures split on who is waiting. A test email is one try, and its failure
 * is the answer: the admin gets a notification with the stable code and the
 * job completes. A password reset has no one waiting, so a failure that a
 * retry can mend is rethrown for BullMQ. One it cannot is an
 * `UnrecoverableError` whose message is the code: nothing set up, a password
 * that no longer decrypts, or the SMTP server's permanent (5xx) refusal, such
 * as bad credentials, which a retry would only repeat. A temporary (4xx)
 * refusal, such as greylisting, is retried.
 *
 * A reset whose link expired in the queue is dropped unsent, as an
 * `UnrecoverableError` whose message is `RESET_LINK_EXPIRED`.
 *
 * A failed send logs one warn line: the job's kind, the mail code and the
 * error's `code`, `responseCode` and `command`, which name the step that
 * failed and carry no message data. It is the admin's only trace for a test
 * (that job completes) and a first clue for a reset. No log line, error
 * message or notification here carries a link, a message body, an error's
 * message or response text, the SMTP password or its ciphertext (#654).
 */
@Injectable()
export class MailDeliveryService {
  private readonly logger = new Logger(MailDeliveryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly encryption: EncryptionService,
    private readonly locale: LocaleResolutionService,
    private readonly i18n: I18nService<I18nTranslations>,
    private readonly notifications: NotificationsService,
  ) {}

  async deliver(job: MailDeliveryJob): Promise<void> {
    // A reset that waited past its token's expiry, as while the worker was
    // down, would mail a dead link that says it still works. Checked on every
    // attempt, so a retry that runs late is dropped too (#654).
    if (job.message.kind === 'password-reset' && Date.now() >= Date.parse(job.message.expiresAt)) {
      throw new UnrecoverableError(RESET_LINK_EXPIRED);
    }

    const recipient = await this.db.user.findUnique({
      where: { id: job.recipientUserId },
      select: { email: true, username: true },
    });

    // The account was deleted after the mail was queued: nobody to tell.
    if (!recipient) {
      return;
    }

    const settings = await this.db.systemSetting.findUnique({
      where: { singleton: true },
      select: MAIL_SETTINGS_SELECT,
    });

    if (!settings || !isMailConfigured(settings)) {
      return this.fail(job, MailFailureCode.NotConfigured);
    }

    let password: string | null;
    try {
      password = settings.smtpPassword ? this.encryption.decrypt(settings.smtpPassword) : null;
    } catch {
      return this.fail(job, MailFailureCode.SettingsUnreadable);
    }

    const lang = await this.locale.resolve({ userId: job.recipientUserId });
    const { subject, text } = renderMail(
      job.message,
      { lang, serverName: settings.name, username: recipient.username },
      this.i18n,
    );

    const transport = createTransport(smtpTransportOptions(settings, password));
    try {
      await transport.sendMail({
        from: mailFrom(settings),
        to: recipient.email,
        subject,
        text,
      });
    } catch (error) {
      const code = classifyMailError(error);
      this.logSendFailure(job, code, error);

      return this.fail(job, code, !isPermanentRefusal(error));
    } finally {
      transport.close();
    }

    if (job.message.kind === 'test') {
      await this.notifyTestResult(job.recipientUserId, null);
    }
  }

  /** Only the fields that name the failed step; never the error's message, response or stack. */
  private logSendFailure(job: MailDeliveryJob, code: MailFailureCode, error: unknown): void {
    const { code: nodemailerCode, responseCode, command } = (error ?? {}) as Record<string, unknown>;
    const facts = Object.entries({ code: nodemailerCode, responseCode, command })
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(([key, value]) => `${key}=${value}`);

    this.logger.warn(`Mail send failed: kind=${job.message.kind} mailCode=${code} ${facts.join(' ')}`.trimEnd());
  }

  /**
   * A test reports the failure to the admin and completes. A reset throws: a
   * `MailTransportError` (retried) for a send a retry may mend, an
   * `UnrecoverableError` for a failure it cannot.
   */
  private async fail(job: MailDeliveryJob, code: MailFailureCode, retryable = false): Promise<void> {
    if (job.message.kind === 'test') {
      return this.notifyTestResult(job.recipientUserId, code);
    }

    if (retryable) {
      throw new MailTransportError(code);
    }

    throw new UnrecoverableError(code);
  }

  private async notifyTestResult(userId: string, code: MailFailureCode | null): Promise<void> {
    await this.notifications.create({
      userId,
      type: NotificationType.MailTestResult,
      payload: {
        outcome: code === null ? 'sent' : 'failed',
        code,
        message: t(mailTestResultMessageKey(code)),
      },
    });
  }
}
