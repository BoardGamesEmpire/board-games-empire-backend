import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { paginated, PaginatedResponseDto } from '@bge/shared';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ListContributionsQueryDto,
  MediaContributionResponseDto,
  RejectContributionDto,
  toMediaContributionResponse,
} from './dto';
import { MediaContributionService } from './media-contribution.service';

const PaginatedContributionsResponse = PaginatedResponseDto(MediaContributionResponseDto, 'contributions');

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('media')
@Controller('media-contributions')
export class MediaContributionController {
  constructor(private readonly contributions: MediaContributionService) {}

  @ApiOperation({
    summary: 'List media contributions the caller may read',
    description:
      'Newest first, optionally narrowed to one `status`. Paginated: `?page=` (1-based) and `?limit=`, ' +
      'with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`; `total` counts the rows ' +
      'matching the status filter, which is what makes it a usable moderation-queue length. See #230.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedContributionsResponse })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.MediaContribution))
  @Get()
  list(@Query() query: ListContributionsQueryDto) {
    return from(this.contributions.list(query)).pipe(
      map(({ rows, total }) =>
        paginated('contributions', { rows: rows.map(toMediaContributionResponse), total }, query),
      ),
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
