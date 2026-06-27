import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { ListContributionsQueryDto, RejectContributionDto, toMediaContributionResponse } from './dto';
import { MediaContributionService } from './media-contribution.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('media')
@Controller('media-contributions')
export class MediaContributionController {
  constructor(private readonly contributions: MediaContributionService) {}

  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.MediaContribution))
  @Get()
  list(@Query() query: ListContributionsQueryDto) {
    return from(this.contributions.list(query)).pipe(
      map((items) => ({ contributions: items.map(toMediaContributionResponse) })),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.MediaContribution))
  @Post(':id/approve')
  approve(@Param('id') id: string) {
    return from(this.contributions.approve(id)).pipe(map((c) => ({ contribution: toMediaContributionResponse(c) })));
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.MediaContribution))
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectContributionDto) {
    return from(this.contributions.reject(id, dto)).pipe(
      map((c) => ({ contribution: toMediaContributionResponse(c) })),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.MediaContribution))
  @Post(':id/reclaim')
  reclaim(@Param('id') id: string) {
    return from(this.contributions.reclaim(id)).pipe(map((c) => ({ contribution: toMediaContributionResponse(c) })));
  }
}
