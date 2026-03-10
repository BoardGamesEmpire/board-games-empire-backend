import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';
import { SystemSettingsService } from './system-settings.service';

@ApiTags('system-settings')
@UseGuards(AuthGuard)
@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  getSystemSettings() {
    return from(this.systemSettingsService.getSystemSettings()).pipe(map((settings) => ({ settings })));
  }

  @Patch(':id')
  updateSystemSettings(@Param('id') id: string, @Body() updateSystemSettingsDto: UpdateSystemSettingsDto) {
    return from(this.systemSettingsService.updateSystemSettings(id, updateSystemSettingsDto)).pipe(
      map((settings) => ({ settings })),
    );
  }
}
