import { Action, QuotaScope, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { isQuotaResource, QuotaService, SetQuotaDto, toPublicScopeId } from '@bge/quota';
import { BadRequestException, Body, Controller, Get, Param, ParseEnumPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { Session } from '@thallesp/nestjs-better-auth';
import { ClsService } from 'nestjs-cls';
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
@ApiTags('admin', 'quotas')
@UseGuards(PoliciesGuard)
@Controller('quotas')
export class QuotasController {
  constructor(
    private readonly quotas: QuotaService,
    private readonly cls: ClsService,
  ) {}

  @ApiOperation({ summary: 'List quotas you can read' })
  @ApiResponse({ status: Http.Ok, description: 'Quotas retrieved' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Quota))
  @Get()
  list() {
    return from(this.quotas.getQuotas(this.getAbilities())).pipe(map((quotas) => ({ quotas })));
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
    @Session() session: UserSession,
  ) {
    if (!isQuotaResource(resource)) {
      throw new BadRequestException(`Unknown quota resource "${resource}"`);
    }

    const publicScopeId = toPublicScopeId(scopeId);
    return from(this.quotas.setQuota(scope, publicScopeId, resource, dto, session.user.id, this.getAbilities())).pipe(
      map((quota) => ({ message: 'Quota set', quota })),
    );
  }

  private getAbilities(): AppAbility[] {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    const apiAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return [userAbility, apiAbility].filter(Boolean);
  }
}
