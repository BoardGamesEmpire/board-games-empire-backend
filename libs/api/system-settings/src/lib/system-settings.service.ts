import { DatabaseService, SystemSetting } from '@bge/database';
import { Injectable } from '@nestjs/common';
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
      throw new Error('No system settings found! Run the seed script to create default settings.');
    }
    if (settings.length > 1) {
      throw new Error('Multiple system settings found! There should only be one. Please fix the database.');
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
