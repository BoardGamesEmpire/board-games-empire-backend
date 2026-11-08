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

/**
 * Whether sending again would get the same answer (#654). When the SMTP
 * server answered, its reply code decides: a 5xx is a permanent refusal (RFC
 * 5321 4.2.1), and a 4xx, such as greylisting, is temporary. Nodemailer also
 * refuses on its own, before the server answers and so with no reply code: a
 * user name with no password, or an envelope it won't send. The same settings
 * fail that way on every try. A connection that fails has no reply code
 * either, and a later try can reach the host.
 */
function isPermanentFailure(error: unknown, code: MailFailureCode): boolean {
  const { responseCode } = (error ?? {}) as { responseCode?: unknown };

  if (typeof responseCode === 'number') {
    return responseCode >= 500 && responseCode < 600;
  }

  return code === MailFailureCode.AuthFailed || code === MailFailureCode.Rejected;
}

/** A failure's class name, never its message, which can carry what was sent. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Why a send did not go: the stable code, and whether a reset's retry could go differently. */
interface SendFailure {
  readonly code: MailFailureCode;
  readonly retryable: boolean;
}

/**
 * The worker's sender (#654). For every job it reads the mail settings from
 * the row, decrypts the SMTP password, renders the message in the recipient's
 * language and sends it over a new transport. Nothing is kept across jobs, so
 * an admin's change applies to the next mail. The transport is not pooled, so
 * keeping it would save no connection: nodemailer connects for each send.
 *
 * Failures split on who is waiting. A test email is one try, and the admin's
 * notification is its answer, whatever failed: the stable code of a failure
 * the send classifies, and `MAIL_SEND_FAILED` for any other, such as a
 * database read that fails. The job then completes. A password reset has no
 * one waiting, so a failure that a retry can mend is rethrown for BullMQ. One
 * it cannot is an `UnrecoverableError` whose message is the code: nothing set
 * up, a password that no longer decrypts, the SMTP server's permanent (5xx)
 * refusal, such as bad credentials, or nodemailer's own refusal before the
 * server answers, such as a user name with no password. A retry would only
 * repeat those. A temporary (4xx) refusal, such as greylisting, is retried.
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
    if (job.message.kind === 'test') {
      return this.deliverTest(job);
    }

    // A reset that waited past its token's expiry, as while the worker was
    // down, would mail a dead link that says it still works. Checked on every
    // attempt, so a retry that runs late is dropped too (#654).
    if (Date.now() >= Date.parse(job.message.expiresAt)) {
      throw new UnrecoverableError(RESET_LINK_EXPIRED);
    }

    const recipient = await this.readRecipient(job);

    // The account was deleted after the mail was queued: nobody to tell.
    if (!recipient) {
      return;
    }

    const failure = await this.send(job, recipient);
    if (failure?.retryable) {
      throw new MailTransportError(failure.code);
    }

    if (failure) {
      throw new UnrecoverableError(failure.code);
    }
  }

  /**
   * The test has one try, and the admin waits on its notification, so any
   * failure becomes one, not only those the send classifies. Otherwise a read
   * that fails, say, would fail the job, and the admin would hear nothing
   * (#654). The notification is written once, after the outcome is known, so
   * a send that went is never reported as failed. Only a notification that
   * cannot be written fails the job, and the processor logs it.
   */
  private async deliverTest(job: MailDeliveryJob): Promise<void> {
    let code: MailFailureCode | null;
    try {
      const recipient = await this.readRecipient(job);

      // The admin's account was deleted after they asked: nobody to tell.
      if (!recipient) {
        return;
      }

      code = (await this.send(job, recipient))?.code ?? null;
    } catch (error) {
      this.logger.warn(
        `Mail test failed outside the send: mailCode=${MailFailureCode.SendFailed} error=${errorName(error)}`,
      );
      code = MailFailureCode.SendFailed;
    }

    await this.notifyTestResult(job.recipientUserId, code);
  }

  private readRecipient(job: MailDeliveryJob): Promise<{ email: string; username: string } | null> {
    return this.db.user.findUnique({
      where: { id: job.recipientUserId },
      select: { email: true, username: true },
    });
  }

  /**
   * One try at sending. It resolves to `null` when the mail went, or to the
   * failure when it did not; anything it cannot classify, such as a database
   * read that fails, it throws.
   */
  private async send(
    job: MailDeliveryJob,
    recipient: { email: string; username: string },
  ): Promise<SendFailure | null> {
    const settings = await this.db.systemSetting.findUnique({
      where: { singleton: true },
      select: MAIL_SETTINGS_SELECT,
    });

    if (!settings || !isMailConfigured(settings)) {
      return { code: MailFailureCode.NotConfigured, retryable: false };
    }

    let password: string | null;
    try {
      password = settings.smtpPassword ? this.encryption.decrypt(settings.smtpPassword) : null;
    } catch {
      return { code: MailFailureCode.SettingsUnreadable, retryable: false };
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

      return { code, retryable: !isPermanentFailure(error, code) };
    } finally {
      transport.close();
    }

    return null;
  }

  /** Only the fields that name the failed step; never the error's message, response or stack. */
  private logSendFailure(job: MailDeliveryJob, code: MailFailureCode, error: unknown): void {
    const { code: nodemailerCode, responseCode, command } = (error ?? {}) as Record<string, unknown>;
    const facts = Object.entries({ code: nodemailerCode, responseCode, command })
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(([key, value]) => `${key}=${value}`);

    this.logger.warn(`Mail send failed: kind=${job.message.kind} mailCode=${code} ${facts.join(' ')}`.trimEnd());
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
