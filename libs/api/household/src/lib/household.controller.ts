import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto, paginated, paginatedEnvelopeSchema, PaginationMetaDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { HouseholdService } from './household.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('households')
// The list response references PaginationMetaDto by `$ref` and nothing else in
// this controller mentions it, so it needs registering explicitly.
@ApiExtraModels(PaginationMetaDto)
@Controller('households')
export class HouseholdController {
  private readonly logger = new Logger(HouseholdController.name);

  constructor(private readonly householdService: HouseholdService) {}

  @ApiOperation({
    summary: 'List households the caller may read (widens with role and friendships)',
    description:
      'Scope depends on the caller: a plain user receives their own memberships AND friends\u2019 ' +
      '`Friends`-visible households; Owner/Admin/Moderator receive every household. For a set that means the ' +
      'same thing for every caller, use `GET /households/mine` (#364). The ambiguity itself is #365. ' +
      'Paginated: `?page=` (1-based) and `?limit=`, with a `pagination` envelope carrying ' +
      '`total`, `totalPages` and `hasMore`. See #230.',
  })
  @ApiResponse({ status: Http.Ok, description: 'Paginated households', schema: paginatedEnvelopeSchema('households') })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Household))
  @Get()
  getHouseholdsForUser(@Query() pagination: DefaultPaginationQueryDto) {
    return from(this.householdService.getHouseholdsForUser(pagination)).pipe(
      map((page) => paginated('households', page, pagination)),
    );
  }

  /**
   * Declared ABOVE `@Get(':id')` and it must stay there: Nest matches in
   * declaration order, so the reverse makes this a 404 from the detail route.
   */
  @ApiOperation({
    summary: 'List households the caller is a member of, whatever their role',
    description:
      'Membership-scoped: households the caller holds a `HouseholdMember` row for, and nothing else. ' +
      'Unlike `GET /households` — which widens with the caller\u2019s role and friendships — this returns the ' +
      'same kind of result for every caller, so a **user session** may treat a household it has cached but ' +
      'does not find here as one it was removed from or one that was deleted. An **API key** is additionally ' +
      'floored by its own permissions (effective access is key ∩ owner), so absence under a key also admits ' +
      '\u201coutside this key\u2019s scope\u201d — do not purge a cache from a key-authenticated read. The key ' +
      'permission model is unbuilt (#270). Paginated identically to `GET /households`: `?page=` (1-based) and ' +
      '`?limit=`, with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`; `total` counts the ' +
      'caller\u2019s visible memberships. See #364, and #365 for the general question.',
  })
  @ApiResponse({ status: Http.Ok, description: 'Paginated households', schema: paginatedEnvelopeSchema('households') })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'Insufficient permissions, or an actor kind with no memberships of its own (plugin, system, external) — ' +
      'provisional, see #395',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Household))
  @Get('mine')
  getHouseholdsForMember(@Query() pagination: DefaultPaginationQueryDto) {
    return from(this.householdService.getHouseholdsForMember(pagination)).pipe(
      map((page) => paginated('households', page, pagination)),
    );
  }

  @ApiOperation({
    summary: 'Create a household',
    description:
      'Idempotent when `clientRequestId` is supplied: a repeat submission with the same key (per user) ' +
      'returns the original household — same id, same 201 envelope — instead of creating a duplicate. ' +
      'The repeat payload is ignored (first writer wins). See #210.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Household))
  @Post()
  create(@Body() createHouseholdDto: CreateHouseholdDto) {
    return from(this.householdService.create(createHouseholdDto)).pipe(
      // The service resolves the acting user, creates the household, and evicts
      // that user's permission graph (they just became a HouseholdOwner).
      map((household) => ({ message: t('success.household.created'), household })),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Household))
  @Get(':id')
  getById(@Param('id') id: string) {
    this.logger.debug(`Fetching household with ID: ${id}`);

    return from(this.householdService.getHouseholdById(id)).pipe(map((household) => ({ household })));
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Household))
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateHouseholdDto: UpdateHouseholdDto) {
    return from(this.householdService.updateHousehold(id, updateHouseholdDto)).pipe(
      map((household) => ({ message: t('success.household.updated', { id }), household })),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.Household))
  @Delete(':id')
  delete(@Param('id') id: string) {
    return from(this.householdService.deleteHousehold(id)).pipe(
      map((household) => ({ message: t('success.household.deleted', { id }), household })),
    );
  }
}
