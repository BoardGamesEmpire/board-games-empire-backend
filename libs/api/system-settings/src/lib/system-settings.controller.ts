import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { NoCache } from '@bge/shared';
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';
import { SystemSettingsService } from './system-settings.service';

@ApiTags('system-settings')
// Never response-cached: an admin re-reads the settings after changing them,
// and a cached read would repeat the value from before the write for the
// whole TTL (#530).
@NoCache()
@UseGuards(AuthGuard, PoliciesGuard)
@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.SystemSetting))
  getSystemSettings() {
    return from(this.systemSettingsService.getSystemSettings()).pipe(map((settings) => ({ settings })));
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.SystemSetting))
  @Patch(':id')
  updateSystemSettings(@Param('id') id: string, @Body() updateSystemSettingsDto: UpdateSystemSettingsDto) {
    return from(this.systemSettingsService.updateSystemSettings(id, updateSystemSettingsDto)).pipe(
      map((settings) => ({ settings })),
    );
  }
}
