import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UpdateMemberRoleDto } from '../dto';
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

  @ApiOperation({ summary: "Change a member's household role (owner transitions go through transfer-ownership)" })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'memberId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Role updated' })
  @ApiResponse({ status: Http.BadRequest, description: 'Own role, an owner, or an unassignable role' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Member or household not found' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdMember))
  @Patch(':memberId/role')
  updateMemberRole(
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
    @Body() updateMemberRoleDto: UpdateMemberRoleDto,
  ) {
    return from(this.memberService.updateMemberRole(householdId, memberId, updateMemberRoleDto)).pipe(
      map((member) => ({ message: t('success.household.member_role_updated', { memberId }), member })),
    );
  }

  // Gated on `update` over HouseholdRole, which — unlike `update` over
  // Household — is Owner-only: `update:household_role:transfer-ownership` is the
  // sole `update`/`manage` grant on that subject, and HouseholdAdmin is
  // explicitly excluded from it in the seed. A gate on
  // `can(update, ResourceType.Household)` would admit Admins, because
  // `update:household` is theirs too and CASL unions the rules for an
  // (action, subject) pair.
  @ApiOperation({ summary: 'Transfer household ownership to another member (current owner only)' })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'memberId', type: String, description: 'HouseholdMember.id of the member to promote' })
  @ApiResponse({ status: Http.Ok, description: 'Ownership transferred' })
  @ApiResponse({ status: Http.BadRequest, description: 'Target is yourself, or already the owner' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not the current owner of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Member or household not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.HouseholdRole))
  @Post(':memberId/transfer-ownership')
  transferOwnership(@Param('householdId') householdId: string, @Param('memberId') memberId: string) {
    return from(this.memberService.transferOwnership(householdId, memberId)).pipe(
      map(({ owner, previousOwner }) => ({
        message: t('success.household.ownership_transferred', { memberId }),
        owner,
        previousOwner,
      })),
    );
  }

  // NOTE: this route MUST be declared before `DELETE :memberId` — NestJS
  // registers routes in declaration order, and the parametric route would
  // otherwise capture the literal `me`. Pinned by a controller test.
  @ApiOperation({ summary: 'Leave the household (acting user)' })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Left the household' })
  @ApiResponse({ status: Http.BadRequest, description: 'Sole owner must transfer ownership first' })
  @ApiResponse({ status: Http.NotFound, description: 'Not a member, or household not found' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.HouseholdMember))
  @Delete('me')
  leaveHousehold(@Param('householdId') householdId: string) {
    return from(this.memberService.leaveHousehold(householdId)).pipe(
      map((member) => ({ message: t('success.household.member_left'), member })),
    );
  }

  @ApiOperation({ summary: 'Remove a member from the household' })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'memberId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Member removed' })
  @ApiResponse({ status: Http.BadRequest, description: 'Sole owner cannot be removed' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Member or household not found' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdMember))
  @Delete(':memberId')
  removeMember(@Param('householdId') householdId: string, @Param('memberId') memberId: string) {
    return from(this.memberService.removeMember(householdId, memberId)).pipe(
      map((member) => ({ message: t('success.household.member_removed', { memberId }), member })),
    );
  }
}
