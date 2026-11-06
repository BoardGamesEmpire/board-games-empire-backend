import { AuditContextService } from '@bge/actor-context';
import { Action, ResourceType } from '@bge/database';
import { AbilityService, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import {
  MODULE_OPTIONS_TOKEN,
  PluginInventoryService,
  presentArtifactChecks,
  type PluginModuleOptions,
} from '@bge/plugin';
import { PluginArtifactInstaller, PluginArtifactReceiver, type PluginArtifactReceipt } from '@bge/plugin-artifacts';
import { resolveLocalizedString } from '@boardgamesempire/plugin-manifest';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  InstallPluginDto,
  PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH,
  PluginArtifactResponseDto,
  PluginInventoryDetailResponseDto,
  PostPluginArtifactDto,
} from './dto';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';
import { PluginArtifactSourceError } from './plugin-artifact-source.error';
import { PluginArtifactUploadInterceptor } from './upload/plugin-artifact-upload.interceptor';
import type { PluginArtifactUploadedFile } from './upload/plugin-artifact-upload.storage';

/** The multipart body as OpenAPI documents it: the same route also takes the JSON body below. */
const UPLOAD_BODY_SCHEMA = {
  type: 'object',
  required: ['file', 'sha256'],
  properties: {
    file: { type: 'string', format: 'binary', description: 'The plugin artifact, a gzip-compressed tar archive' },
    sha256: {
      type: 'string',
      maxLength: PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH,
      description: 'The SHA-256 checksum the plugin artifact must have',
    },
  },
};

/**
 * The install ingress (#1094): a server admin posts a plugin artifact by link
 * or by upload, reads what it asks for at their own pace, and installs it by
 * naming its checksum. The services behind these routes, and the upload
 * interceptor ahead of the post, check the actor is a server admin before they
 * read a byte, so this edge holds the coarse `manage:plugin` gate and the
 * translation of the request. The actor comes from CLS and never from the
 * body.
 *
 * It is listed after `PluginsController` in the module, and must stay there:
 * `artifacts/:sha256` would otherwise capture `GET /plugins/artifacts/consent`
 * and `/features`, which belong to a plugin slugged `artifacts` (a valid slug,
 * deliberately not reserved). The reverse costs nothing, since no checksum is
 * either word.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@UseFilters(PluginExceptionFilter)
// The post's body schema points at this class, which no `@Body()` type would
// register once `@ApiBody` replaces it.
@ApiExtraModels(PostPluginArtifactDto)
@ApiTags('plugins')
@Controller('plugins')
export class PluginArtifactsController {
  constructor(
    private readonly receiver: PluginArtifactReceiver,
    private readonly installer: PluginArtifactInstaller,
    private readonly inventory: PluginInventoryService,
    private readonly abilityService: AbilityService,
    private readonly auditContext: AuditContextService,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  @ApiOperation({
    summary: 'Post a plugin artifact, by link or by upload',
    description:
      'Takes the plugin artifact as JSON `{ url, sha256 }`, which the server downloads, or as multipart `file` ' +
      'and `sha256`. The checksum is the one the server admin expects, and the bytes must match it. The answer is ' +
      'what the artifact asks for, so the server admin can decide at their own pace: nothing is installed. Posting ' +
      'the same plugin artifact again answers the same. Unless it is installed, it is kept for 7 days after it was ' +
      'last posted or last read for an install.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    schema: { oneOf: [{ $ref: getSchemaPath(PostPluginArtifactDto) }, UPLOAD_BODY_SCHEMA] },
  })
  @ApiResponse({ status: Http.Ok, type: PluginArtifactResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description: 'Neither a link nor a file, or both, or a multipart upload in a form the route does not take',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.PayloadTooLarge, description: 'The plugin artifact is over the size limit' })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'The checksum does not match, the archive breaks an archive rule (`rule` says which), or the link ' +
      'is refused (`reason` says why)',
  })
  @ApiResponse({ status: Http.BadGateway, description: 'The download failed (`reason` says how)' })
  @ApiResponse({
    status: Http.ServiceUnavailable,
    description: 'Static analysis is unavailable on this server; an operator must fix the parser installation',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @UseInterceptors(PluginArtifactUploadInterceptor)
  @Post('artifacts')
  post(@Body() dto: PostPluginArtifactDto, @UploadedFile() file?: PluginArtifactUploadedFile) {
    const actorId = this.abilityService.getActingUserId();
    // A form that submits an empty `url` beside its file is an upload, and an
    // empty `url` alone names no link.
    const url = dto.url === undefined || dto.url === null || dto.url === '' ? undefined : dto.url;

    if (file !== undefined && url !== undefined) {
      throw new PluginArtifactSourceError('both');
    }

    const receipt =
      file !== undefined
        ? this.receiver.receiveUpload({
            archivePath: file.path,
            sha256: file.sha256,
            bytes: file.size,
            expectedSha256: dto.sha256,
            actorId,
          })
        : url !== undefined
          ? this.receiver.receiveByLink({ url, expectedSha256: dto.sha256, actorId })
          : Promise.reject(new PluginArtifactSourceError('none'));

    return from(receipt).pipe(map((received) => this.present(received)));
  }

  @ApiOperation({
    summary: 'Read a posted plugin artifact back',
    description:
      'The same answer as posting it: what the plugin artifact asks for, recomputed from its directory. The ' +
      'checksum may be in either case. 404 when no plugin artifact with the checksum is waiting, whether it ' +
      'expired, was installed or was never posted.',
  })
  @ApiResponse({ status: Http.Ok, type: PluginArtifactResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'No plugin artifact with this checksum is waiting to be installed',
  })
  @ApiResponse({
    status: Http.ServiceUnavailable,
    description: 'Static analysis is unavailable on this server; an operator must fix the parser installation',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  // Out of the response cache: reading it right after an install must show it gone.
  @Get('artifacts/:sha256')
  read(@Param('sha256') sha256: string) {
    // Past the cap it is not a checksum whatever it holds. Cutting it keeps the
    // 404 from echoing an arbitrarily long path segment back.
    const asked = sha256.slice(0, PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH);

    return from(this.receiver.read(asked, this.abilityService.getActingUserId())).pipe(
      map((received) => this.present(received)),
    );
  }

  @ApiOperation({
    summary: 'Install a posted plugin artifact by its checksum',
    description:
      'Installs the plugin artifact the checksum names, with the confirmations its read asked for. Answers 201 ' +
      "with the new plugin's inventory entry. Sending it again once it is installed, as a retry or a double click " +
      'does, answers the same and installs nothing. A wrong or missing confirmation is a 409 challenge carrying ' +
      'what it expected.',
  })
  @ApiResponse({ status: Http.Created, type: PluginInventoryDetailResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'No plugin artifact with this checksum is waiting to be installed',
  })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'A confirmation is missing or wrong, the plugin is already installed, or someone reinstalled it at the same moment',
  })
  @ApiResponse({
    status: Http.ServiceUnavailable,
    description: 'Static analysis is unavailable on this server; an operator must fix the parser installation',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @Post('install')
  install(@Body() dto: InstallPluginDto) {
    return from(
      this.installer
        .install({
          sha256: dto.sha256,
          actorId: this.abilityService.getActingUserId(),
          confirmCriticalSlugs: dto.confirmCriticalSlugs,
          acknowledgeForbiddenImports: dto.acknowledgeForbiddenImports,
          deepScan: dto.deepScan,
        })
        // Read back through the inventory, in the viewpoint the inventory's
        // own server read serves a server admin, so a client gets one shape for it.
        .then(({ plugin }) => this.inventory.getBySlug(plugin.slug, this.auditContext.getLocale() ?? undefined)),
    ).pipe(map((installed) => ({ plugin: installed })));
  }

  private present(receipt: PluginArtifactReceipt): PluginArtifactResponseDto {
    const locale = this.auditContext.getLocale() ?? undefined;
    const { defaultLocale } = this.options;
    const { artifact, assessment, installedPlugin } = receipt;
    const { manifest, warnings } = assessment.validated;
    const text = (value: Parameters<typeof resolveLocalizedString>[0]): string =>
      resolveLocalizedString(value, { locale: locale ?? defaultLocale, defaultLocale });

    return {
      artifact: {
        sha256: artifact.sha256,
        slug: artifact.slug,
        version: artifact.version,
        compressedBytes: artifact.compressedBytes,
        url: artifact.url,
        registrySlug: artifact.registrySlug,
        expiresAt: artifact.expiresAt,
      },
      manifest: {
        slug: manifest.slug,
        version: manifest.version,
        displayName: text(manifest.displayName),
        description: text(manifest.description),
        category: manifest.category,
        scope: manifest.scope,
        bgeCompat: manifest.bgeCompat,
        executionMode: manifest.executionMode ?? 'in-process',
        outboundDomains: manifest.network.outboundDomains,
        features: manifest.features.map((feature) => ({
          name: feature.name,
          displayName: text(feature.displayName),
          description: text(feature.description),
        })),
      },
      checks: [...presentArtifactChecks(assessment, locale, defaultLocale)] as PluginArtifactResponseDto['checks'],
      criticalSlugsToReenter: [...assessment.criticalSlugsToReenter],
      forbiddenImportsToAccept: [...assessment.forbiddenImportsToAccept],
      analysis: {
        findings: [...assessment.analysis.findings],
        truncated: assessment.analysis.truncated,
        scannedFileCount: assessment.analysis.scannedFileCount,
      },
      warnings: [...warnings],
      installedPlugin: { state: installedPlugin.state, version: installedPlugin.version },
    };
  }
}
