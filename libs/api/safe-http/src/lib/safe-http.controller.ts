import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UpdateSafeHttpPolicyDto } from './dto/update-safe-http-policy.dto';
import { SafeHttpService } from './safe-http.service';

@ApiTags('safe-http-policy')
@UseGuards(AuthGuard, PoliciesGuard)
@Controller('safe-http-policy')
export class SafeHttpController {
  constructor(private readonly safeHttpService: SafeHttpService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.SafeHttpPolicy))
  getPolicy() {
    return from(this.safeHttpService.getPolicy()).pipe(map((policy) => ({ policy })));
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.SafeHttpPolicy))
  updatePolicy(@Param('id') id: string, @Body() dto: UpdateSafeHttpPolicyDto) {
    return from(this.safeHttpService.updatePolicy(id, dto)).pipe(map((policy) => ({ policy })));
  }
}
