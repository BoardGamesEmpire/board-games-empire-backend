import { DatabaseService, SystemSetting } from '@bge/database';
import { t } from '@bge/i18n';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';

@Injectable()
export class SystemSettingsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * There can be only one!
   *
   * @returns Promise<SystemSetting>
   */
  async getSystemSettings(): Promise<SystemSetting> {
    const settings = await this.db.systemSetting.findMany();
    if (settings.length === 0) {
      throw new NotFoundException(t('errors.system_settings.not_found'));
    }

    if (settings.length > 1) {
      throw new ConflictException(t('errors.system_settings.multiple'));
    }

    return settings[0];
  }

  async updateSystemSettings(settingsId: string, updateSettingsDTO: UpdateSystemSettingsDto): Promise<SystemSetting> {
    return this.db.systemSetting.update({
      where: { id: settingsId },
      data: {
        ...updateSettingsDTO,
      },
    });
  }
}
