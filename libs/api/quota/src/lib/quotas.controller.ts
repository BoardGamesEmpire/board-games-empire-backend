import { Action, QuotaScope, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { isQuotaResource, QuotaService, SetQuotaDto, toPublicScopeId } from '@bge/quota';
import { BadRequestException, Body, Controller, Get, Param, ParseEnumPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Admin surface for operational caps. Server admins manage any row; household
 * admins are narrowed by CASL to their own household's `HouseholdMember` rows
 * (manage) and may read their household's caps. A `:scopeId` of `*` addresses
 * the type-level default for the scope.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('quotas')
@UseGuards(PoliciesGuard)
@Controller('quotas')
export class QuotasController {
  constructor(private readonly quotas: QuotaService) {}

  @ApiOperation({ summary: 'List quotas you can read' })
  @ApiResponse({ status: Http.Ok, description: 'Quotas retrieved' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Quota))
  @Get()
  list() {
    return from(this.quotas.getQuotas()).pipe(map((quotas) => ({ quotas })));
  }

  @ApiOperation({ summary: 'Create or update a quota (partial — only provided fields change)' })
  @ApiParam({ name: 'scope', enum: QuotaScope })
  @ApiParam({ name: 'scopeId', description: 'Instance id, or "*" for the type-level default' })
  @ApiParam({ name: 'resource', description: 'A registered quota resource key' })
  @ApiResponse({ status: Http.Ok, description: 'Quota set' })
  @ApiResponse({ status: Http.BadRequest, description: 'Unknown resource or incoherent scope target' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Quota))
  @Patch(':scope/:scopeId/:resource')
  set(
    @Param('scope', new ParseEnumPipe(QuotaScope)) scope: QuotaScope,
    @Param('scopeId') scopeId: string,
    @Param('resource') resource: string,
    @Body() dto: SetQuotaDto,
  ) {
    if (!isQuotaResource(resource)) {
      throw new BadRequestException(t('errors.quota.unknown_resource', { resource }));
    }

    const publicScopeId = toPublicScopeId(scopeId);
    return from(this.quotas.setQuota(scope, publicScopeId, resource, dto)).pipe(
      map((quota) => ({ message: t('success.quota.set'), quota })),
    );
  }
}
