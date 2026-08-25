import { PluginCategory, PluginExecutionMode, PluginScope } from '@bge/database';
import type {
  PluginHouseholdInventoryEntry,
  PluginInventoryDetail,
  PluginInventoryEntry,
  PluginInventoryFeature,
  PluginInventoryIdentity,
  PluginInventoryPendingUpdate,
  PluginInventoryUnitState,
  PluginUnitInventoryEntry,
} from '@bge/plugin';
import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

/**
 * OpenAPI models for the installed-plugin reads (#354).
 *
 * Every class here `implements` its runtime counterpart from `@bge/plugin`.
 * That is the whole point of declaring them: the row shapes are defined by
 * the inventory service, and a documented shape that merely resembles the
 * served one drifts silently — a field added to the service would leave the
 * generated client blind to it, with nothing failing. With `implements`, the
 * omission is a compile error in this file.
 *
 * Modelled rather than declared unknown (`paginatedEnvelopeSchema`, which
 * households still use pending #376) because this issue OWNS the row shape:
 * there is no pre-existing entity whose partial projection we would be
 * guessing at.
 */

/** Bundled: ships with BGE, so there is no artifact to describe. */
class BundledProvenanceDto {
  @ApiProperty({ enum: ['bundled'] })
  kind!: 'bundled';
}

class InstalledProvenanceDto {
  @ApiProperty({ enum: ['installed'] })
  kind!: 'installed';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'SHA-256 of the installed tarball. Null only if the install invariant was violated.',
  })
  sha256!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Ingress URL; null for a manual upload' })
  url!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Registry source the artifact was discovered through' })
  registrySlug!: string | null;
}

class PendingUpdateDto implements PluginInventoryPendingUpdate {
  @ApiProperty({ description: 'The staged version awaiting consent' })
  version!: string;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'When the update was staged — pendingSince, not updatedAt',
  })
  since!: Date | null;
}

/**
 * The identity half — everything any viewpoint may see. The unit DTOs extend
 * THIS, never {@link PluginInventoryEntryDto}, mirroring the runtime split:
 * the operational and provenance fields belong to the `read:plugin` surface
 * alone, and inheriting them into an ungated response is exactly the mistake
 * the two shapes exist to make impossible.
 */
export class PluginInventoryIdentityDto implements PluginInventoryIdentity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Manifest slug — the install identity every other plugin route addresses' })
  slug!: string;

  @ApiProperty({ enum: PluginCategory, enumName: 'PluginCategory' })
  category!: PluginCategory;

  @ApiProperty({ enum: PluginScope, enumName: 'PluginScope' })
  scope!: PluginScope;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Localized manifest displayName; null when the stored manifest could not be read',
  })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Localized manifest description; null as above' })
  description!: string | null;

  @ApiProperty({
    description:
      "This row's stored manifest failed re-validation, so its localized fields are absent and nothing " +
      'manifest-derived about it can be trusted. The identity fields above are still accurate — they come from ' +
      'the row, not the manifest — which is what keeps the plugin actionable (it can still be uninstalled).',
  })
  manifestUnreadable!: boolean;
}

/** The server viewpoint (`read:plugin`): identity plus the operational picture. */
@ApiExtraModels(BundledProvenanceDto, InstalledProvenanceDto)
export class PluginInventoryEntryDto extends PluginInventoryIdentityDto implements PluginInventoryEntry {
  @ApiProperty({ description: 'Currently ACTIVE manifest version' })
  version!: string;

  @ApiProperty({ description: 'The server-level kill switch; unit enablement layers under it' })
  enabled!: boolean;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'Set only on tombstoned rows, which appear solely when includeUninstalled is requested',
  })
  uninstalledAt!: Date | null;

  @ApiProperty({ description: 'An update activated in the DB while the process still runs the prior code' })
  restartRequired!: boolean;

  @ApiProperty()
  installedAt!: Date;

  // The mapping is not optional here. An implicit discriminator resolves the
  // property's value against SCHEMA NAMES, and 'bundled'/'installed' match
  // neither `BundledProvenanceDto` nor `InstalledProvenanceDto` — a generated
  // client would find the union unresolvable. This is the repo's first
  // `discriminator`, so there was no precedent to inherit the mapping from.
  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(BundledProvenanceDto) }, { $ref: getSchemaPath(InstalledProvenanceDto) }],
    discriminator: {
      propertyName: 'kind',
      mapping: {
        bundled: getSchemaPath(BundledProvenanceDto),
        installed: getSchemaPath(InstalledProvenanceDto),
      },
    },
  })
  provenance!: PluginInventoryEntry['provenance'];

  @ApiProperty({ type: PendingUpdateDto, nullable: true, description: 'Null when no update is staged' })
  pendingUpdate!: PendingUpdateDto | null;
}

class UnitStateDto implements PluginInventoryUnitState {
  @ApiProperty({
    description:
      'Whether an enablement row exists at all. False is common and distinct from enabled=false: a user who has ' +
      'consented to nothing is unanchored on every plugin.',
  })
  anchored!: boolean;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty()
  suspendedForConsent!: boolean;

  @ApiProperty({ type: Date, nullable: true })
  suspendedAt!: Date | null;
}

export class PluginUnitInventoryEntryDto extends PluginInventoryIdentityDto implements PluginUnitInventoryEntry {
  @ApiProperty({
    description:
      'The server switch, under which your own enablement layers. Enabling a unit while the server has the ' +
      'plugin off does nothing, so this is what lets a screen explain the silence. Named apart from unit.enabled ' +
      'so the two switches cannot be misread for each other.',
  })
  serverEnabled!: boolean;

  @ApiProperty({ type: UnitStateDto })
  unit!: UnitStateDto;
}

export class PluginHouseholdInventoryEntryDto
  extends PluginUnitInventoryEntryDto
  implements PluginHouseholdInventoryEntry
{
  @ApiProperty({
    description:
      'This household holds an enablement row for a plugin whose current scope has no household axis — an ' +
      'activation narrowed the scope without retiring the row (#369). Listed rather than hidden: it is enabled and ' +
      'serving nothing, which is precisely what an admin needs to see.',
  })
  scopeOrphaned!: boolean;
}

class InventoryFeatureDto implements PluginInventoryFeature {
  @ApiProperty({ description: 'Manifest features[].name — the stable identifier' })
  name!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty()
  description!: string;
}

export class PluginInventoryDetailDto extends PluginInventoryEntryDto implements PluginInventoryDetail {
  @ApiProperty({ enum: PluginExecutionMode, enumName: 'PluginExecutionMode' })
  executionMode!: PluginExecutionMode;

  @ApiProperty({
    type: [InventoryFeatureDto],
    description:
      'Localized manifest features. Empty when none are declared — never because the manifest was unreadable, which is a 500 on this route.',
  })
  features!: InventoryFeatureDto[];
}

/**
 * The single-plugin read's actual body. The handler emits `{ plugin: … }`, so
 * documenting the entry as the whole response would send a generated client
 * looking for `slug` at the top level. Same wrapper convention as
 * `GameCollectionResponseDto`.
 */
export class PluginInventoryDetailResponseDto {
  @ApiProperty({ type: PluginInventoryDetailDto })
  plugin!: PluginInventoryDetailDto;
}
