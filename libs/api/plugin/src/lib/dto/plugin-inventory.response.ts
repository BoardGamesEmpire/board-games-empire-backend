import { PluginCategory, PluginExecutionMode, PluginScope, RiskLevel } from '@bge/database';
import type {
  ConsentOutstandingCheck,
  ConsentOutstandingKind,
  PluginConsentStanding,
  PluginHouseholdInventoryEntry,
  PluginInventoryDetail,
  PluginInventoryEntry,
  PluginInventoryFeature,
  PluginInventoryIdentity,
  PluginInventoryPendingUpdate,
  PluginInventoryUnitState,
  PluginProvenance,
  PluginUnitInventoryEntry,
  PluginUnitStateCode,
} from '@bge/plugin';
import { PLUGIN_UNIT_STATE_CODES } from '@bge/plugin';
import { ApiProperty } from '@nestjs/swagger';

/**
 * OpenAPI models for the installed-plugin reads (#354).
 *
 * Every class that models a runtime shape `implements` it. That is the whole
 * point of declaring these: the row shapes are defined by the inventory
 * service, and a documented shape that merely resembles the served one drifts
 * silently — a field added to the service would leave the generated client
 * blind to it, with nothing failing. With `implements`, the omission is a
 * compile error in this file.
 *
 * The one class with no `implements` is
 * {@link PluginInventoryDetailResponseDto}: it models the transport ENVELOPE
 * (`{ plugin: … }`), which the runtime never names because wrapping is the
 * controller's business.
 *
 * Modelled rather than declared unknown (`paginatedEnvelopeSchema`, which
 * households still use pending #376) because this issue OWNS the row shape:
 * there is no pre-existing entity whose partial projection we would be
 * guessing at.
 */

/**
 * The four kinds, listed for OpenAPI (#1149). Keyed by the runtime union so a
 * kind added there fails to compile here until the OpenAPI list gains it.
 */
const CONSENT_OUTSTANDING_KIND_LIST: Record<ConsentOutstandingKind, true> = {
  never_asked: true,
  refused: true,
  risk_raised: true,
  outstanding_elsewhere: true,
};
const CONSENT_OUTSTANDING_KINDS = Object.keys(CONSENT_OUTSTANDING_KIND_LIST);

/** Where the plugin artifact came from. One shape: every plugin is installed from an artifact (#696). */
class PluginProvenanceDto implements PluginProvenance {
  // Typed off the interface so the brand carries without this lib importing
  // it; on the wire it is a plain string (#1117).
  @ApiProperty({ type: String, description: 'SHA-256 of the installed plugin artifact' })
  sha256!: PluginProvenance['sha256'];

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
    description: 'When the update was staged — pendingSince, not updatedAt',
  })
  since!: Date;

  @ApiProperty({
    type: String,
    description:
      'The staging approve and reject must name. Reported here too, because a staging whose manifest no longer ' +
      'validates cannot be presented by GET /plugins/:slug/update/pending but can still be rejected with this id',
  })
  stagingId!: string;
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

  @ApiProperty({ type: PluginProvenanceDto })
  provenance!: PluginProvenanceDto;

  @ApiProperty({ type: PendingUpdateDto, nullable: true, description: 'Null when no update is staged' })
  pendingUpdate!: PendingUpdateDto | null;
}

export class ConsentOutstandingCheckDto implements ConsentOutstandingCheck {
  @ApiProperty({ description: 'The permission slug of the check' })
  slug!: string;

  @ApiProperty({
    enum: CONSENT_OUTSTANDING_KINDS,
    enumName: 'ConsentOutstandingKind',
    description:
      'Why the check confers nothing yet. These are stable codes a client can announce or rephrase. ' +
      'never_asked: no decision has been made. refused: a durable denial was recorded. risk_raised: the earlier ' +
      'consent no longer covers the permission, whose risk has risen since. outstanding_elsewhere: only another ' +
      'scope can answer it, such as a server admin for a server-consented check seen from a household or user.',
  })
  kind!: ConsentOutstandingKind;

  @ApiProperty({
    description:
      'True for a permission the plugin says it cannot work without: while such a check is outstanding the unit ' +
      'reads review_pending and keeps running on the grants it gave, with the ability denying what was not ' +
      'granted. False for an optional check, which only switches its feature off.',
  })
  required!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The manifest feature name the check belongs to; null for a check that covers the whole plugin',
  })
  feature!: string | null;

  @ApiProperty({
    enum: RiskLevel,
    enumName: 'RiskLevel',
    nullable: true,
    description:
      "The permission's risk today; null when a core permission is no longer in the catalog. A permission the " +
      'plugin declares is always Low.',
  })
  riskLevel!: RiskLevel | null;

  @ApiProperty({ description: 'Plain-language reason, localized, as the plugin states it' })
  reason!: string;
}

export class PluginConsentStandingDto implements PluginConsentStanding {
  @ApiProperty({
    type: [ConsentOutstandingCheckDto],
    description:
      'Required checks that confer nothing yet. While any remain, the unit state is review_pending: the unit ' +
      'keeps its unit enablement and consent standing is worked out on every read, never stored (#1149).',
  })
  outstanding!: ConsentOutstandingCheckDto[];

  @ApiProperty({
    type: [ConsentOutstandingCheckDto],
    description: 'Optional checks that confer nothing yet. Each switches its feature off without holding the unit.',
  })
  optionalOff!: ConsentOutstandingCheckDto[];
}

class UnitStateDto implements PluginInventoryUnitState {
  @ApiProperty({
    description:
      'Whether a unit enablement exists at all. False is common and distinct from enabled=false: a user who has ' +
      'consented to nothing is unanchored on every plugin.',
  })
  anchored!: boolean;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({
    enum: PLUGIN_UNIT_STATE_CODES,
    enumName: 'PluginUnitStateCode',
    description:
      'The unit state, a stable code a client can announce or rephrase. off: no unit enablement, or it is switched ' +
      'off. on: running with everything the plugin asks for. review_pending: running on what was agreed while ' +
      'required checks are outstanding, see consent; it can list only outstanding_elsewhere entries, a ' +
      'server-scope permission a server admin must answer, and a client renders that as waiting on the server ' +
      'admin, not as a prompt the household or user can accept. ' +
      'needs_configuration: the retained configuration no longer fits the active schema; supplying a conforming ' +
      'document heals it. unavailable: switched on, but the server cannot run it for this unit, because the ' +
      'server switch is off (serverEnabled false) or the plugin no longer has this axis; only a server admin ' +
      'restores it. Worked out on every read, never stored.',
  })
  state!: PluginUnitStateCode;

  @ApiProperty({
    type: PluginConsentStandingDto,
    description: 'What the unit still owes the plugin, worked out from its grants and the active manifest',
  })
  consent!: PluginConsentStandingDto;
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

/** The household list shares the unit shape; a switched-on unit enablement that serves nothing reads `unavailable` or `needs_configuration` (#1149). */
export class PluginHouseholdInventoryEntryDto
  extends PluginUnitInventoryEntryDto
  implements PluginHouseholdInventoryEntry {}

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
