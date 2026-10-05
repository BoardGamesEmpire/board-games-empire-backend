import { DatabaseService, isPrismaDependentRecordNotFoundError } from '@bge/database';
import { t } from '@bge/i18n';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';
import { SYSTEM_SETTINGS_SELECT, type SystemSettingsView } from './read-shapes';

@Injectable()
export class SystemSettingsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * There can be only one!
   *
   * @returns Promise<SystemSettingsView>
   */
  async getSystemSettings(): Promise<SystemSettingsView> {
    const settings = await this.db.systemSetting.findMany({ select: SYSTEM_SETTINGS_SELECT });
    if (settings.length === 0) {
      throw new NotFoundException(t('errors.system_settings.not_found'));
    }

    if (settings.length > 1) {
      throw new ConflictException(t('errors.system_settings.multiple'));
    }

    return settings[0];
  }

  /**
   * An unknown id answers 404. `update` throws P2025 when no row matches, and
   * nothing else maps that to a response, so it answered 500 (#571).
   */
  async updateSystemSettings(
    settingsId: string,
    updateSettingsDTO: UpdateSystemSettingsDto,
  ): Promise<SystemSettingsView> {
    try {
      return await this.db.systemSetting.update({
        where: { id: settingsId },
        data: {
          ...updateSettingsDTO,
        },
        select: SYSTEM_SETTINGS_SELECT,
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new NotFoundException(t('errors.system_settings.id_not_found', { id: settingsId }));
      }

      throw error;
    }
  }
}
