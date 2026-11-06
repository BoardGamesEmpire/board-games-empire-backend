import { Action, ResourceType } from '@bge/database';
import { AbilityService, CheckPolicies, PoliciesGuard, resolveScopeSubjectId } from '@bge/permissions';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UpdateSystemSettingsDto } from './dto/update-system-settings.dto';
import { SystemSettingsService } from './system-settings.service';

@ApiTags('system-settings')
// Must stay out of the response cache: an admin re-reads the settings after
// changing them, and a cached read would repeat the value from before the
// write for the whole TTL (#530).
@UseGuards(PoliciesGuard)
@Controller('system-settings')
export class SystemSettingsController {
  constructor(
    private readonly systemSettingsService: SystemSettingsService,
    private readonly abilityService: AbilityService,
  ) {}

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

  /** Queues a test email to the acting admin's own address (#654). */
  @ApiResponse({ status: 202, description: 'A test email is queued for the acting admin' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Outgoing mail is not set up (code MAIL_NOT_CONFIGURED)' })
  @ApiResponse({ status: 503, description: "The job queue's Redis is down (code MAIL_QUEUE_UNAVAILABLE)" })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.SystemSetting))
  @HttpCode(202)
  @Post('mail-test')
  async mailTest() {
    await this.systemSettingsService.sendTestMail(resolveScopeSubjectId(this.abilityService));

    return { queued: true as const };
  }
}
