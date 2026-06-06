import { DatabaseService, SystemSetting } from '@bge/database';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import assert from 'node:assert';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';

@Injectable()
export class SystemSettingsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * There can be only one!
   */
  async getSystemSettings() {
    return from(this.db.systemSetting.findMany()).pipe(
      tap((settings) => this.ensureSingleton(settings)),
      map((settings) => ({ settings: settings[0] })),
    );
  }

  updateSystemSettings(settingsId: string, updateSettingsDTO: UpdateSystemSettingsDto) {
    return from(
      this.db.systemSetting.update({
        where: { id: settingsId },
        data: {
          ...updateSettingsDTO,
        },
      }),
    ).pipe(map((settings) => ({ settings })));
  }

  private ensureSingleton(settings: SystemSetting[]) {
    assert(
      settings.length > 0,
      new NotFoundException('No system settings found! Run the seed script to create default settings.'),
    );

    assert(
      settings.length === 1,
      new ConflictException('Multiple system settings found! There can be only one. Please fix the database.'),
    );
  }
}
