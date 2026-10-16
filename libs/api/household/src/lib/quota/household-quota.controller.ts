import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { QuotaService } from '@bge/quota';
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { HouseholdLivenessGuard, HouseholdPathParam } from '../guards/household-liveness.guard';

/**
 * One household's quotas, split off `GET /quotas` so that list declares its
 * own set (#515). Lives in this lib rather than beside `QuotasController`
 * because it needs the household liveness guard, and `QuotaService` already
 * reaches this lib through `QuotaModule`.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('quotas')
// Liveness first, as on `HouseholdMemberController` (#299): a deleted
// household is 404, whatever quota permission its admins held while it was
// live.
@HouseholdPathParam('householdId')
@UseGuards(HouseholdLivenessGuard, PoliciesGuard)
@Controller('households/:householdId/quotas')
export class HouseholdQuotaController {
  constructor(private readonly quotas: QuotaService) {}

  @ApiOperation({
    summary: 'List a household\u2019s quotas',
    description:
      'The household\u2019s own quotas and its members\u2019 quotas. Readable by the household\u2019s ' +
      'owners and admins, by staff and by the Owner. Server, user and default quotas are on `GET /quotas`. ' +
      'Not paginated: ' +
      'one row per scope, target and resource.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Quotas retrieved' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not permitted to read this household\u2019s quotas' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Quota))
  @Get()
  list(@Param('householdId') householdId: string) {
    return from(this.quotas.getHouseholdQuotas(householdId)).pipe(map((quotas) => ({ quotas })));
  }
}
