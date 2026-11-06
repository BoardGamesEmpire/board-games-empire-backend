import { DatabaseService, isPrismaDependentRecordNotFoundError } from '@bge/database';
import { t } from '@bge/i18n';
import { EncryptionService } from '@bge/services';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';
import { SYSTEM_SETTINGS_ROW_SELECT, toView, type SystemSettingsView } from './read-shapes';

@Injectable()
export class SystemSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly encryption: EncryptionService,
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
   */
  async updateSystemSettings(
    settingsId: string,
    updateSettingsDTO: UpdateSystemSettingsDto,
  ): Promise<SystemSettingsView> {
    const { smtpPassword, ...rest } = updateSettingsDTO;
    if (smtpPassword === undefined) {
      await this.refuseKeptPasswordForNewServer(settingsId, updateSettingsDTO);
    }

    try {
      const row = await this.db.systemSetting.update({
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
  private async refuseKeptPasswordForNewServer(settingsId: string, update: UpdateSystemSettingsDto): Promise<void> {
    const { smtpHost, smtpPort, smtpSecurity } = update;
    if (smtpHost === undefined && smtpPort === undefined && smtpSecurity === undefined) {
      return;
    }

    const stored = await this.db.systemSetting.findUnique({
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
}
