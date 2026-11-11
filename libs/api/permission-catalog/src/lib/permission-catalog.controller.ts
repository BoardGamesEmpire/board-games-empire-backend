import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { CatalogEntryNamePipe } from './catalog-entry-name.pipe';
import { CatalogEditRefusalDto, CatalogErrorDto } from './dto/catalog-refusal.response';
import {
  CatalogRoleDto,
  GrantEditDto,
  HandBackDto,
  PermissionCatalogDto,
  PermissionEditDto,
} from './dto/catalog.response';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { PermissionCatalogService } from './permission-catalog.service';

const GRANT_CHECK_REFUSAL =
  'The change fails the entry check (code CATALOG_ENTRY_REFUSED): `problems` lists each problem by `kind`, such as ' +
  'names-other-roles for a grant whose condition names only other roles, so it would confer nothing, or ' +
  'fails-open for a household or event role that would reach every household or event. Or it would leave the ' +
  'Owner without full control of the server (code CATALOG_OWNER_LOCKOUT).';

/**
 * The 409 for an entry that changed between the read and the write, and what
 * to read again before retrying: the entry itself, or for a grant the role it
 * is listed under.
 */
function changedWhileSaving(entry: 'permission' | 'role' | 'grant'): string {
  const readAgain = entry === 'grant' ? 'the role' : `the ${entry}`;

  return (
    `the ${entry} was changed while the change was being saved, and the change was not saved; read ` +
    `${readAgain} again and retry (code CATALOG_ENTRY_CHANGED)`
  );
}

/**
 * The permission catalog as the Owner reads and edits it (#772).
 *
 * No role holds a permission on `Permission`, `Role` or `RolePermission`, so
 * only the Owner's `manage:all` reaches a write here. Staff read every
 * resource type, so they can read the permission catalog too, as they can
 * the system settings.
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
    description: `The permission belongs to a plugin, which keeps it (code CATALOG_ENTRY_NOT_EDITABLE). Or ${changedWhileSaving('permission')}`,
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
  updatePermission(
    @Param('slug', CatalogEntryNamePipe) slug: string,
    @Body() body: UpdatePermissionDto,
  ): Promise<PermissionEditDto> {
    return this.permissionCatalogService.updatePermission(slug, body);
  }

  @ApiOperation({
    summary: "Edit a role's description",
    description:
      "Sets the role's description. The role becomes the Owner's: later versions of the server leave its " +
      'description as edited and report how it differs, until it is handed back. Sending the current ' +
      'description answers the role as it is and writes nothing.',
  })
  @ApiResponse({ status: Http.Ok, type: CatalogRoleDto })
  @ApiResponse({ status: Http.BadRequest, description: 'A description that is not text or null, or another property' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    type: CatalogErrorDto,
    description: 'No role has this name (code CATALOG_ENTRY_NOT_FOUND)',
  })
  @ApiResponse({
    status: Http.Conflict,
    type: CatalogErrorDto,
    description: `The role belongs to a plugin, which keeps it (code CATALOG_ENTRY_NOT_EDITABLE). Or ${changedWhileSaving('role')}`,
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Role))
  @Patch('roles/:name')
  updateRole(@Param('name', CatalogEntryNamePipe) name: string, @Body() body: UpdateRoleDto): Promise<CatalogRoleDto> {
    return this.permissionCatalogService.updateRole(name, body);
  }

  @ApiOperation({
    summary: 'Give a role a permission',
    description:
      "Adds the grant, or gives back one that was revoked. The grant becomes the Owner's, so later versions of " +
      'the server keep it. Every cached permission is recomputed on the next request. A grant the role already ' +
      'holds is answered as it is, and nothing is written.',
  })
  @ApiResponse({ status: Http.Ok, type: GrantEditDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    type: CatalogErrorDto,
    description: 'No role has this name, or no permission this slug (code CATALOG_ENTRY_NOT_FOUND)',
  })
  @ApiResponse({
    status: Http.Conflict,
    type: CatalogErrorDto,
    description:
      'The role, the permission or the grant belongs to a plugin (code CATALOG_ENTRY_NOT_EDITABLE). Or the ' +
      'permission is retired, so the grant would do nothing; revive the permission first (code ' +
      'CATALOG_PERMISSION_RETIRED). Or the role has no scope this version of the server knows, so the grant ' +
      'could not be checked (code CATALOG_ROLE_NOT_JUDGEABLE). Or ' +
      changedWhileSaving('grant'),
  })
  @ApiResponse({ status: Http.UnprocessableEntity, type: CatalogEditRefusalDto, description: GRANT_CHECK_REFUSAL })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.RolePermission))
  @Put('roles/:name/grants/:slug')
  addGrant(
    @Param('name', CatalogEntryNamePipe) name: string,
    @Param('slug', CatalogEntryNamePipe) slug: string,
  ): Promise<GrantEditDto> {
    return this.permissionCatalogService.addGrant(name, slug);
  }

  @ApiOperation({
    summary: 'Take a permission from a role',
    description:
      "Revokes the grant. A grant this version of the server ships is kept, revoked and the Owner's, so later " +
      'versions do not give it back until it is handed back; one this server added is deleted. Every cached ' +
      'permission is recomputed on the next request. A grant the Owner already revoked is answered as it is, ' +
      'and nothing is written.',
  })
  @ApiResponse({ status: Http.Ok, type: GrantEditDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    type: CatalogErrorDto,
    description:
      'No role has this name, no permission this slug, or the role does not hold it (code CATALOG_ENTRY_NOT_FOUND)',
  })
  @ApiResponse({
    status: Http.Conflict,
    type: CatalogErrorDto,
    description: `The role, the permission or the grant belongs to a plugin (code CATALOG_ENTRY_NOT_EDITABLE). Or ${changedWhileSaving('grant')}`,
  })
  @ApiResponse({ status: Http.UnprocessableEntity, type: CatalogEditRefusalDto, description: GRANT_CHECK_REFUSAL })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.RolePermission))
  @Delete('roles/:name/grants/:slug')
  revokeGrant(
    @Param('name', CatalogEntryNamePipe) name: string,
    @Param('slug', CatalogEntryNamePipe) slug: string,
  ): Promise<GrantEditDto> {
    return this.permissionCatalogService.revokeGrant(name, slug);
  }

  @ApiOperation({
    summary: 'Hand a permission back to the server',
    description:
      'Marks the permission as maintained by the server again, so the next start brings it in line with the permission catalog this version ships: its edits are undone, a retired permission it ships is revived, and one it no longer ships is retired. ' +
      'Nothing else changes now: the next start brings it in line, which `nextStart` says. An entry the server already maintains is answered the same way and nothing is written.',
  })
  @ApiResponse({ status: Http.Ok, type: HandBackDto })
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
    description: `The permission belongs to a plugin, which keeps it (code CATALOG_ENTRY_NOT_EDITABLE). Or ${changedWhileSaving('permission')}`,
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Permission))
  @HttpCode(Http.Ok)
  @Post('permissions/:slug/hand-back')
  handBackPermission(@Param('slug', CatalogEntryNamePipe) slug: string): Promise<HandBackDto> {
    return this.permissionCatalogService.handBackPermission(slug);
  }

  @ApiOperation({
    summary: 'Hand a role back to the server',
    description:
      'Marks the role as maintained by the server again, so the next start restores the description this version ships. ' +
      'Nothing else changes now: the next start brings it in line, which `nextStart` says. An entry the server already maintains is answered the same way and nothing is written.',
  })
  @ApiResponse({ status: Http.Ok, type: HandBackDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    type: CatalogErrorDto,
    description: 'No role has this name (code CATALOG_ENTRY_NOT_FOUND)',
  })
  @ApiResponse({
    status: Http.Conflict,
    type: CatalogErrorDto,
    description: `The role belongs to a plugin, which keeps it (code CATALOG_ENTRY_NOT_EDITABLE). Or ${changedWhileSaving('role')}`,
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Role))
  @HttpCode(Http.Ok)
  @Post('roles/:name/hand-back')
  handBackRole(@Param('name', CatalogEntryNamePipe) name: string): Promise<HandBackDto> {
    return this.permissionCatalogService.handBackRole(name);
  }

  @ApiOperation({
    summary: 'Hand a grant back to the server',
    description:
      'Marks the grant as maintained by the server again, so the next start does what this version ships: a revoked grant it lists is given back (`grant-restored`), and a grant it does not list, which this server added, is deleted (`grant-removed`). ' +
      "A revoked grant it lists that the entry check fails because of this server's other edits, such as a condition changed to name other roles, is withheld (`grant-withheld`): left revoked and judged again at each start, with `problems` saying why. " +
      'Nothing else changes now: the next start brings it in line, which `nextStart` says. An entry the server already maintains is answered the same way and nothing is written.',
  })
  @ApiResponse({ status: Http.Ok, type: HandBackDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    type: CatalogErrorDto,
    description:
      'No role has this name, no permission this slug, or the role does not hold it (code CATALOG_ENTRY_NOT_FOUND)',
  })
  @ApiResponse({
    status: Http.Conflict,
    type: CatalogErrorDto,
    description: `The role, the permission or the grant belongs to a plugin (code CATALOG_ENTRY_NOT_EDITABLE). Or ${changedWhileSaving('grant')}`,
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.RolePermission))
  @HttpCode(Http.Ok)
  @Post('roles/:name/grants/:slug/hand-back')
  handBackGrant(
    @Param('name', CatalogEntryNamePipe) name: string,
    @Param('slug', CatalogEntryNamePipe) slug: string,
  ): Promise<HandBackDto> {
    return this.permissionCatalogService.handBackGrant(name, slug);
  }
}
