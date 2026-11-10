import {
  Action,
  CATALOG_MANIFEST,
  edgeKey,
  PermissionOwner,
  RiskLevel,
  type EntryWarning,
  type FieldChange,
  type PermissionSnapshotRow,
  type Prisma,
  type RolePermissionSnapshotRow,
  type RoleSnapshotRow,
} from '@bge/database';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';

/**
 * OpenAPI models for the permission catalog as the Owner's routes return it
 * (#772). The service builds plain objects of these shapes.
 */

/** Any JSON value: a drifted column holds a string, a list, an object, a date or null. */
const ANY_JSON = [
  { type: 'string' },
  { type: 'number' },
  { type: 'boolean' },
  { type: 'array', items: {} },
  { type: 'object' },
];

/** One column where an entry the Owner edited differs from the permission catalog this version ships. */
export class CatalogFieldChangeDto implements FieldChange {
  @ApiProperty({
    description:
      'The column: for a permission one of action, subject, fields, conditions, inverted, reason, riskLevel or retiredAt; for a role, description.',
  })
  field!: string;

  @ApiProperty({ description: 'What this server holds.', oneOf: ANY_JSON, nullable: true })
  from!: unknown;

  @ApiProperty({ description: 'What this version of the server ships.', oneOf: ANY_JSON, nullable: true })
  to!: unknown;
}

const DRIFT_DESCRIPTION =
  'How the entry differs from the permission catalog this version ships. Only an entry the Owner edited (managedBy ' +
  "Admin) can differ: every start brings the server's own entries in line, so theirs is always empty.";

/**
 * Who maintains an entry, published under the glossary's name for it (#772).
 * The Prisma enum keeps its own name, `PermissionOwner`.
 */
const MANAGED_BY = { enum: PermissionOwner, enumName: 'ManagedBy' } as const;

export class CatalogPermissionDto {
  @ApiProperty({ description: "The permission's stable name, such as update:event." })
  slug!: string;

  @ApiProperty({ enum: Action, enumName: 'Action' })
  action!: Action;

  @ApiProperty({ description: 'The resource type the permission is written against, or all.' })
  subject!: string;

  @ApiProperty({ type: [String], description: 'The fields the permission is limited to. Empty means every field.' })
  fields!: string[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'The condition that limits which records it reaches. An empty object is no condition.',
  })
  conditions!: Prisma.JsonValue | null;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ enum: RiskLevel, enumName: 'RiskLevel' })
  riskLevel!: RiskLevel;

  @ApiProperty({
    ...MANAGED_BY,
    description: 'Who maintains it: System, the server; Admin, the Owner, who edited it; Plugin, a plugin.',
  })
  managedBy!: PermissionOwner;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'When it was retired. A retired permission is kept and confers nothing.',
  })
  retiredAt!: Date | null;

  @ApiProperty({
    description:
      'Whether the permission catalog this version ships lists the permission. False for one a plugin added, or ' +
      'one a newer version stopped shipping, which a start retires.',
  })
  shipped!: boolean;

  @ApiProperty({ type: [CatalogFieldChangeDto], description: DRIFT_DESCRIPTION })
  drift!: CatalogFieldChangeDto[];
}

export class CatalogGrantDto {
  @ApiProperty({ description: 'The slug of the permission the role holds.' })
  slug!: string;

  @ApiProperty(MANAGED_BY)
  managedBy!: PermissionOwner;

  @ApiProperty({
    type: Date,
    nullable: true,
    description:
      'When it was revoked. A revoked grant is kept, so the next start does not give it back, and confers nothing.',
  })
  revokedAt!: Date | null;

  @ApiProperty({
    description:
      'Whether the permission catalog this version ships gives the role this permission. A grant the Owner ' +
      'added on this server is not shipped, so revoking it deletes it and handing it back removes it at the next ' +
      'start; a shipped grant the Owner revoked and gave back is shipped, though the Owner manages it.',
  })
  shipped!: boolean;
}

export class CatalogRoleDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty(MANAGED_BY)
  managedBy!: PermissionOwner;

  @ApiProperty({ type: [CatalogFieldChangeDto], description: DRIFT_DESCRIPTION })
  drift!: CatalogFieldChangeDto[];

  @ApiProperty({ type: [CatalogGrantDto], description: 'Every grant the role has, revoked ones included.' })
  grants!: CatalogGrantDto[];
}

/** `GET /permission-catalog`. */
export class PermissionCatalogDto {
  @ApiProperty({ type: [CatalogPermissionDto], description: 'Every permission, retired ones included, by slug.' })
  permissions!: CatalogPermissionDto[];

  @ApiProperty({ type: [CatalogRoleDto], description: 'Every role, by name.' })
  roles!: CatalogRoleDto[];
}

/** Something the entry check allows but reports, so the Owner can see it. */
export class EntryWarningDto {
  @ApiProperty({
    enum: ['unconditioned-global', 'unpaired'],
    description:
      'unconditioned-global: a server-wide role, such as User, holds the permission with no condition, so it ' +
      'reaches every record of its resource type. unpaired: the role holds one half of a pair, such as approving ' +
      "a household's invites without revoking them, and none of the other halves.",
  })
  kind!: EntryWarning['kind'];

  @ApiProperty()
  slug!: string;

  @ApiProperty({ description: 'The role the warning is about.' })
  role!: string;

  @ApiPropertyOptional({ type: [String], description: 'For unpaired: the slugs that would pair it.' })
  partners?: readonly string[];
}

/** `PATCH /permission-catalog/permissions/:slug`. */
export class PermissionEditDto {
  @ApiProperty({ type: CatalogPermissionDto, description: 'The permission as edited.' })
  permission!: CatalogPermissionDto;

  @ApiProperty({ type: [EntryWarningDto] })
  warnings!: EntryWarning[];

  @ApiProperty({
    description:
      'How many plugin consent decisions stopped conferring the permission with this edit: a condition that no ' +
      'longer binds the household or user that consented, a risk level above the one consent was given at, or ' +
      'the permission retired. Only decisions in force are counted: those of an enabled, installed plugin whose ' +
      'manifest still asks for the permission, made for the server or for a household or user the plugin is ' +
      'switched on for. Each such plugin needs consent again.',
  })
  consentDecisionsAffected!: number;
}

/** `PUT` and `DELETE /permission-catalog/roles/:name/grants/:slug`. */
export class GrantEditDto {
  @ApiProperty({
    type: CatalogGrantDto,
    nullable: true,
    description:
      'The grant as the change left it. Null when a revoke deleted it: a grant this server added, which the ' +
      'permission catalog does not ship, is deleted rather than kept revoked.',
  })
  grant!: CatalogGrantDto | null;

  @ApiProperty({
    type: [EntryWarningDto],
    description:
      'What the change is allowed with but should be seen, such as a role left holding one half of a pair, like ' +
      "approving a household's invites without revoking them.",
  })
  warnings!: EntryWarning[];
}

const SHIPPED_PERMISSIONS: ReadonlySet<string> = new Set(CATALOG_MANIFEST.permissions.map(({ slug }) => slug));

const SHIPPED_GRANTS: ReadonlySet<string> = new Set(
  Object.entries(CATALOG_MANIFEST.rolePermissions).flatMap(([roleName, slugs]) =>
    slugs.map((slug) => edgeKey(roleName, slug)),
  ),
);

/** Whether the permission catalog this version ships gives `roleName` the permission `slug`. */
export function catalogListsGrant(roleName: string, slug: string): boolean {
  return SHIPPED_GRANTS.has(edgeKey(roleName, slug));
}

/** A grant row as the routes return it, under its role. */
export function catalogGrant({
  roleName,
  permissionSlug,
  managedBy,
  revokedAt,
}: RolePermissionSnapshotRow): CatalogGrantDto {
  return { slug: permissionSlug, managedBy, revokedAt, shipped: catalogListsGrant(roleName, permissionSlug) };
}

/** A role row as the routes return it: its grants, by slug in code-unit order, and its drift. */
export function catalogRole(
  { name, description, managedBy }: RoleSnapshotRow,
  grants: readonly RolePermissionSnapshotRow[],
  drift: readonly FieldChange[],
): CatalogRoleDto {
  return {
    name,
    description,
    managedBy,
    drift: [...drift],
    grants: grants.map(catalogGrant).sort((a, b) => codeUnitOrder(a.slug, b.slug)),
  };
}

/** Code-unit order: the same on every server, whatever its locale. */
export function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A permission row as the routes return it, with its drift. */
export function catalogPermission(row: PermissionSnapshotRow, drift: readonly FieldChange[]): CatalogPermissionDto {
  return {
    slug: row.slug,
    action: row.action,
    subject: row.subject,
    fields: [...row.fields],
    conditions: row.conditions,
    reason: row.reason,
    riskLevel: row.riskLevel,
    managedBy: row.managedBy,
    retiredAt: row.retiredAt,
    shipped: SHIPPED_PERMISSIONS.has(row.slug),
    drift: [...drift],
  };
}

/** `POST /permission-catalog/.../hand-back`. */
@ApiExtraModels(CatalogFieldChangeDto)
export class HandBackDto {
  @ApiProperty({
    oneOf: [
      { type: 'array', items: { $ref: getSchemaPath(CatalogFieldChangeDto) } },
      { type: 'string', enum: ['grant-restored', 'grant-removed'] },
    ],
    description:
      'What the next start changes. For a permission or a role, the columns it restores, `from` what this server ' +
      "holds `to` what this version ships; a permission it retires or revives shows `retiredAt`: 'retired' as `to` " +
      'for one this version no longer ships, and null for one it ships again. For a grant, grant-restored when the ' +
      'next start gives back a revoked grant, or grant-removed when it deletes a grant this version does not ship. ' +
      'An empty list means the next start changes nothing.',
  })
  nextStart!: FieldChange[] | 'grant-restored' | 'grant-removed';
}
