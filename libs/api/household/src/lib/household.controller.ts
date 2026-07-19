import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { HouseholdService } from './household.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('households')
@Controller('households')
export class HouseholdController {
  private readonly logger = new Logger(HouseholdController.name);

  constructor(private readonly householdService: HouseholdService) {}

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Household))
  @Get()
  getHouseholdsForUser(@Query() pagination: DefaultPaginationQueryDto) {
    return from(this.householdService.getHouseholdsForUser(pagination)).pipe(map((households) => ({ households })));
  }

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
