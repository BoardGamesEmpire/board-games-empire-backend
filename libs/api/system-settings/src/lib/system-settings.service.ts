import { DatabaseService, isPrismaDependentRecordNotFoundError, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { isMailConfigured, MAIL_READINESS_SELECT, MailFailureCode } from '@bge/mail';
import { MailDispatcherService, MailQueueUnavailableError } from '@bge/queue-mail';
import { EncryptionService } from '@bge/services';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';
import { SYSTEM_SETTINGS_ROW_SELECT, toView, type SystemSettingsView } from './read-shapes';

@Injectable()
export class SystemSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly encryption: EncryptionService,
    private readonly mailDispatcher: MailDispatcherService,
  ) {}

  /**
   * There can be only one!
   *
   * @returns Promise<SystemSettingsView>
   */
  async getSystemSettings(): Promise<SystemSettingsView> {
    const settings = await this.db.systemSetting.findMany({ select: SYSTEM_SETTINGS_ROW_SELECT });
    if (settings.length === 0) {
      throw new NotFoundException(t('errors.system_settings.not_found'));
    }

    if (settings.length > 1) {
      throw new ConflictException(t('errors.system_settings.multiple'));
    }

    return toView(settings[0]);
  }

  /**
   * An unknown id answers 404. `update` throws P2025 when no row matches, and
   * nothing else maps that to a response, so it answered 500 (#571).
   *
   * The check on a kept SMTP password and the write run in one transaction,
   * with the row locked `FOR UPDATE` before the check (#654). Every other
   * settings write is an `UPDATE`, which waits on that lock, so a concurrent
   * write either commits first and is checked, or waits and lands after.
   * Without the lock, a password saved between the check and the write would
   * be kept for the server this patch names.
   */
  async updateSystemSettings(
    settingsId: string,
    updateSettingsDTO: UpdateSystemSettingsDto,
  ): Promise<SystemSettingsView> {
    const { smtpPassword, ...rest } = updateSettingsDTO;

    try {
      const row = await this.db.$transaction(async (tx) => {
        if (smtpPassword === undefined) {
          await this.refuseKeptPasswordForNewServer(tx, settingsId, updateSettingsDTO);
        }

        return tx.systemSetting.update({
          where: { id: settingsId },
          // The password is stored as ciphertext only (#654). An omitted key
          // stays out of `data`, so the stored one is kept; null clears it.
          data: {
            ...rest,
            ...(smtpPassword !== undefined && {
              smtpPassword: smtpPassword === null ? null : this.encryption.encrypt(smtpPassword),
            }),
          },
          select: SYSTEM_SETTINGS_ROW_SELECT,
        });
      });

      return toView(row);
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new NotFoundException(t('errors.system_settings.id_not_found', { id: settingsId }));
      }

      throw error;
    }
  }

  /**
   * The stored SMTP password goes only to the server it was saved for (#654).
   * A change of host, port or connection security that keeps it would let
   * anyone who can edit the settings, but cannot read the password, point the
   * worker at a server they run and receive it. So such a change must send
   * the password again, or null to clear it. Clearing the host is allowed:
   * with no host nothing is sent anywhere.
   */
  private async refuseKeptPasswordForNewServer(
    tx: Prisma.TransactionClient,
    settingsId: string,
    update: UpdateSystemSettingsDto,
  ): Promise<void> {
    const { smtpHost, smtpPort, smtpSecurity } = update;
    if (smtpHost === undefined && smtpPort === undefined && smtpSecurity === undefined) {
      return;
    }

    await tx.$queryRaw(Prisma.sql`SELECT id FROM system_settings WHERE id = ${settingsId} FOR UPDATE`);

    const stored = await tx.systemSetting.findUnique({
      where: { id: settingsId },
      select: { smtpHost: true, smtpPort: true, smtpSecurity: true, smtpPassword: true },
    });
    if (!stored?.smtpPassword) {
      // No password to keep; an unknown id answers 404 from the update.
      return;
    }

    const host = smtpHost === undefined ? stored.smtpHost : smtpHost;
    const serverChanged =
      host !== stored.smtpHost ||
      (smtpPort !== undefined && smtpPort !== stored.smtpPort) ||
      (smtpSecurity !== undefined && smtpSecurity !== stored.smtpSecurity);

    if (serverChanged && host !== null) {
      throw new BadRequestException({
        code: 'SMTP_PASSWORD_REQUIRED',
        message: t('errors.system_settings.smtp_password_required'),
      });
    }
  }

  /**
   * Queues a test email to the admin asking for it, so they learn whether the
   * mail settings work (#654). It refuses while mail is not set up, answers
   * 503 at once while the queue's Redis is down, and any other queue failure
   * propagates as a 500: an admin asking for a test should hear that it
   * failed. Whether the SMTP server then accepts it shows in the worker's
   * delivery notification.
   */
  async sendTestMail(recipientUserId: string): Promise<void> {
    const row = await this.db.systemSetting.findUnique({
      where: { singleton: true },
      select: MAIL_READINESS_SELECT,
    });

    if (!isMailConfigured(row)) {
      throw new ConflictException({
        code: MailFailureCode.NotConfigured,
        message: t('errors.system_settings.mail_not_configured'),
      });
    }

    try {
      await this.mailDispatcher.enqueue(recipientUserId, { kind: 'test' });
    } catch (error) {
      if (error instanceof MailQueueUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'MAIL_QUEUE_UNAVAILABLE',
          message: t('errors.system_settings.mail_queue_unavailable'),
        });
      }

      throw error;
    }
  }
}
