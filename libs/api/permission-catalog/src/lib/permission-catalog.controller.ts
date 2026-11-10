import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { CatalogEditRefusalDto, CatalogErrorDto } from './dto/catalog-refusal.response';
import { PermissionCatalogDto, PermissionEditDto } from './dto/catalog.response';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { PermissionCatalogService } from './permission-catalog.service';

/**
 * The permission catalog as the Owner reads and edits it (#772).
 *
 * No role holds a permission on `Permission`, so only the Owner's
 * `manage:all` reaches a write here. Staff read every resource type, so they
 * can read the permission catalog too, as they can the system settings.
 *
 * Kept out of the response cache: the Owner reads the permission catalog
 * again after an edit, and a cached read would show it as it was.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('permission-catalog')
@UseGuards(PoliciesGuard)
@Controller('permission-catalog')
export class PermissionCatalogController {
  constructor(private readonly permissionCatalogService: PermissionCatalogService) {}

  @ApiOperation({
    summary: 'Read the permission catalog',
    description:
      'Every permission and role on this server, with their grants, and how the entries the Owner edited differ ' +
      'from the permission catalog this version ships.',
  })
  @ApiResponse({ status: Http.Ok, type: PermissionCatalogDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Permission))
  @Get()
  getCatalog(): Promise<PermissionCatalogDto> {
    return this.permissionCatalogService.getCatalog();
  }

  @ApiOperation({
    summary: 'Edit a permission',
    description:
      "Changes a permission's condition, reason or risk level, or retires or revives it. The permission becomes " +
      "the Owner's: later versions of the server leave it as edited and report how it differs, until it is handed " +
      'back. Every cached permission is recomputed on the next request. An edit that changes nothing answers the ' +
      'permission as it is and writes nothing.',
  })
  @ApiResponse({ status: Http.Ok, type: PermissionEditDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A property that cannot be edited, a value of the wrong kind, or nothing to change (code CATALOG_EDIT_EMPTY)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    type: CatalogErrorDto,
    description: 'No permission has this slug (code CATALOG_ENTRY_NOT_FOUND)',
  })
  @ApiResponse({
    status: Http.Conflict,
    type: CatalogErrorDto,
    description:
      'The permission belongs to a plugin, which keeps it (code CATALOG_ENTRY_NOT_EDITABLE). Or it was changed ' +
      'while the edit was being saved, for example by a server start bringing it in line, and the edit was not ' +
      'saved; read it again and retry (code CATALOG_ENTRY_CHANGED)',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    type: CatalogEditRefusalDto,
    description:
      'The edit fails the entry check (code CATALOG_ENTRY_REFUSED): `problems` lists each problem by `kind`, such ' +
      'as query-rejected for a condition the database cannot run, or fails-open for a household or event role ' +
      'that would reach every household or event. Or it would leave the Owner without full control of the server ' +
      '(code CATALOG_OWNER_LOCKOUT).',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Permission))
  @Patch('permissions/:slug')
  updatePermission(@Param('slug') slug: string, @Body() body: UpdatePermissionDto): Promise<PermissionEditDto> {
    return this.permissionCatalogService.updatePermission(slug, body);
  }
}
