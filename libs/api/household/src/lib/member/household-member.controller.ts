import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { HouseholdMemberService } from './household-member.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('household-members')
@UseGuards(PoliciesGuard)
@Controller('households/:householdId/members')
export class HouseholdMemberController {
  constructor(private readonly memberService: HouseholdMemberService) {}

  @ApiOperation({ summary: 'List members of a household' })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Members retrieved' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.HouseholdMember))
  @Get()
  getMembers(@Param('householdId') householdId: string, @Query() pagination: DefaultPaginationQueryDto) {
    return from(this.memberService.getMembers(householdId, pagination)).pipe(map((members) => ({ members })));
  }

  @ApiOperation({ summary: 'Get a single household member' })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'memberId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Member retrieved' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Member or household not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.HouseholdMember))
  @Get(':memberId')
  getMember(@Param('householdId') householdId: string, @Param('memberId') memberId: string) {
    return from(this.memberService.getMember(householdId, memberId)).pipe(map((member) => ({ member })));
  }
}
