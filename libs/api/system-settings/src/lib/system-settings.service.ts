import { DatabaseService, SystemSetting } from '@bge/database';
import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';

@Injectable()
export class SystemSettingsService implements OnModuleInit {
  private readonly logger = new Logger(SystemSettingsService.name);

  constructor(private readonly db: DatabaseService, private readonly configService: ConfigService) {}

  /**
   * There can be only one!
   *
   * @returns Promise<SystemSetting>
   */
  async getSystemSettings(): Promise<SystemSetting> {
    const settings = await this.db.systemSetting.findMany();
    if (settings.length === 0) {
      throw new NotFoundException('No system settings found! Run the seed script to create default settings.');
    }

    if (settings.length > 1) {
      throw new ConflictException('Multiple system settings found! There should only be one. Please fix the database.');
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

  async onModuleInit() {
    this.logger.log('Checking for existing system settings...');
    const settings = await this.db.systemSetting.findFirst();
    if (!settings) {
      this.logger.log('No system settings found, creating default settings...');
      await this.db.systemSetting.create({
        data: {
          allowPasswordResets: this.configService.get('systemSettings.allowPasswordResets', true),
          allowUserRegistration: this.configService.get('systemSettings.allowUserRegistration', true),
          allowUsernameChange: this.configService.get('systemSettings.allowUsernameChange', true),
          identifier: this.configService.get('systemSettings.identifier', crypto.randomUUID()),
        },
      });

      this.logger.log('Default system settings created.');
    }
  }
}
