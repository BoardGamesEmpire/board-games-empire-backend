import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { SystemSettingsService } from './system-settings.service';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';

@ApiTags('system-settings')
@UseGuards(AuthGuard)
@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  getSystemSettings() {
    return this.systemSettingsService.getSystemSettings();
  }

  @Patch(':id')
  updateSystemSettings(@Param('id') id: string, @Body() updateSystemSettingsDto: UpdateSystemSettingsDto) {
    return this.systemSettingsService.updateSystemSettings(id, updateSystemSettingsDto);
  }
}
