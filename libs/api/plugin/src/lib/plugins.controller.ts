import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PluginLifecycleService } from '@bge/plugin';
import { Body, Controller, HttpCode, Param, Patch, Post, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UninstallPluginDto, UpdatePluginConfigDto } from './dto';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';

/**
 * Server-level plugin lifecycle (#59 Phase C4, #320): the admin's
 * enable/disable switch, the server config write, and uninstall. Plugins
 * are addressed by slug at the HTTP edge; toggles are POST verb sub-paths
 * per house style, and uninstall is a POST rather than a DELETE because the
 * resource tombstones (410 afterward) instead of disappearing — and
 * `purgeData` belongs in a body, which DELETE should not carry.
 *
 * The coarse `manage:plugin` CASL gate lives here; the service seam
 * re-verifies server-admin authority and owns every domain rule. Actor
 * identity is resolved from CLS at this edge and passed into the runtime
 * input — never read from a request body.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@UseFilters(PluginExceptionFilter)
@ApiTags('plugins')
@Controller('plugins')
export class PluginsController {
  constructor(
    private readonly lifecycle: PluginLifecycleService,
    private readonly abilityService: AbilityService,
  ) {}

  @ApiOperation({ summary: 'Enable a plugin (server-level switch)' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/enable')
  enable(@Param('slug') slug: string) {
    return from(this.lifecycle.enable({ slug, actorId: this.abilityService.getActingUserId() })).pipe(
      map((plugin) => ({ message: t('success.plugin.enabled', { slug }), plugin })),
    );
  }

  @ApiOperation({ summary: 'Disable a plugin (server-level switch)' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/disable')
  disable(@Param('slug') slug: string) {
    return from(this.lifecycle.disable({ slug, actorId: this.abilityService.getActingUserId() })).pipe(
      map((plugin) => ({ message: t('success.plugin.disabled', { slug }), plugin })),
    );
  }

  @ApiOperation({
    summary: 'Replace the server-scope plugin configuration',
    description:
      "Validates the payload against the manifest's config.schema (422 with issues[] on violation), persists it, " +
      'and triggers the config hot-reload. Last-writer-wins; there is no optimistic locking.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({ status: Http.UnprocessableEntity, description: 'Configuration violates the declared schema' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @Patch(':slug/config')
  updateConfig(@Param('slug') slug: string, @Body() dto: UpdatePluginConfigDto) {
    return from(
      this.lifecycle.updateConfig({ slug, actorId: this.abilityService.getActingUserId(), config: dto.config }),
    ).pipe(map((plugin) => ({ message: t('success.plugin.config_updated', { slug }), plugin })));
  }

  @ApiOperation({
    summary: 'Uninstall a plugin (tombstone)',
    description:
      'Purges all consent (grants and the declared-permission catalog — reinstall is fresh consent), retains the row ' +
      'and unit configuration unless purgeData is true, and clears any staged update. The loaded module keeps running ' +
      'until restart but is no longer served; restartRequired records that. Bundled plugins refuse with 409.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was already uninstalled' })
  @ApiResponse({ status: Http.Conflict, description: 'Bundled plugins cannot be uninstalled' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/uninstall')
  uninstall(@Param('slug') slug: string, @Body() dto: UninstallPluginDto) {
    return from(
      this.lifecycle.uninstall({ slug, actorId: this.abilityService.getActingUserId(), purgeData: dto.purgeData }),
    ).pipe(
      map(({ plugin, affectedUnits }) => ({
        message: t('success.plugin.uninstalled', { slug }),
        plugin,
        affectedUnits,
      })),
    );
  }
}
