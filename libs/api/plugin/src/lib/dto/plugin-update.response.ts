import type { Plugin, PluginConsentAct, PluginGrant, PluginProcessRole, Prisma } from '@bge/database';
import {
  PLUGIN_PROCESS_ROLES,
  PluginCategory,
  PluginConsentActKind,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
} from '@bge/database';
import type {
  PluginUpdateReconsentHouseholdUnit,
  PluginUpdateReconsentUserUnit,
  UpdateEscalation,
  UpdateEscalationComparison,
} from '@bge/plugin';
import type { PluginConsentScopeValue } from '@boardgamesempire/plugin-manifest';
import { PLUGIN_CONSENT_SCOPES } from '@boardgamesempire/plugin-manifest';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PluginInventoryDetailDto } from './plugin-inventory.response';

/**
 * OpenAPI models for the staged update's routes: staging one from a plugin
 * artifact, and the update approval (#1096). As in the inventory models, each
 * class that models a runtime shape `implements` it, so a field the runtime
 * gains is a compile error here instead of a field the generated client
 * cannot see.
 */

/** Keyed by every kind the runtime has, so a new kind fails to compile here until OpenAPI lists it (#1096). */
const UPDATE_ESCALATION_KIND_KEYS: Record<UpdateEscalation['kind'], true> = {
  'new-permission': true,
  'permission-promoted-to-required': true,
  'risk-escalated': true,
  'outbound-domain-added': true,
  'outbound-domains-configured': true,
  'consent-scope-changed': true,
  'writes-core-added': true,
};
const UPDATE_ESCALATION_KINDS = Object.keys(UPDATE_ESCALATION_KIND_KEYS);

/**
 * One way an update asks for more than the active version does. The runtime
 * shape is a union keyed by `kind`, so every other field is optional here and
 * present only on the kinds that carry it. Its spec fails the typecheck when a
 * kind gains a field this class does not document (#1096).
 */
export class UpdateEscalationDto {
  @ApiProperty({
    enum: UPDATE_ESCALATION_KINDS,
    enumName: 'UpdateEscalationKind',
    description:
      'What the update asks for that the active version does not. new-permission: a permission the active ' +
      'version does not request. permission-promoted-to-required: an optional permission becomes required. ' +
      'risk-escalated: a decided permission now carries a higher risk than when it was decided. ' +
      'outbound-domain-added: a domain the plugin will reach. outbound-domains-configured: the plugin will reach ' +
      'whatever domains a server admin configures, instead of a list. consent-scope-changed: another consent ' +
      'scope now answers a permission. writes-core-added: a core model the plugin will write.',
  })
  kind!: UpdateEscalation['kind'];

  @ApiPropertyOptional({ description: 'The permission slug, on the kinds about one permission' })
  slug?: string;

  @ApiPropertyOptional({
    enum: PLUGIN_CONSENT_SCOPES,
    description: 'Who consents to the permission under the update: new-permission, permission-promoted-to-required',
  })
  consentScope?: PluginConsentScopeValue;

  @ApiPropertyOptional({ description: 'new-permission: whether the update marks the permission required' })
  required?: boolean;

  @ApiPropertyOptional({
    enum: PluginGrantScope,
    enumName: 'PluginGrantScope',
    description: 'risk-escalated: the consent scope of the decision whose risk rose',
  })
  scopeType?: PluginGrantScope;

  @ApiPropertyOptional({
    enum: RiskLevel,
    enumName: 'RiskLevel',
    description: 'risk-escalated: the risk the permission carried when it was decided',
  })
  decidedRiskLevel?: RiskLevel;

  @ApiPropertyOptional({
    enum: RiskLevel,
    enumName: 'RiskLevel',
    description: 'risk-escalated: the risk the permission carries now',
  })
  currentRiskLevel?: RiskLevel;

  @ApiPropertyOptional({ description: 'outbound-domain-added: the domain' })
  domain?: string;

  @ApiPropertyOptional({
    enum: PLUGIN_CONSENT_SCOPES,
    description: 'consent-scope-changed: the consent scope that answered the permission before',
  })
  from?: PluginConsentScopeValue;

  @ApiPropertyOptional({
    enum: PLUGIN_CONSENT_SCOPES,
    description: 'consent-scope-changed: the consent scope that answers it under the update',
  })
  to?: PluginConsentScopeValue;

  @ApiPropertyOptional({ description: 'writes-core-added: the core model' })
  model?: string;
}

export class UpdateComparisonDto implements UpdateEscalationComparison {
  // Typed off the interface: the union is what the runtime serves, and the
  // DTO above documents it.
  @ApiProperty({ type: [UpdateEscalationDto] })
  escalations!: UpdateEscalationComparison['escalations'];

  @ApiProperty({
    description:
      "True when the update needed the server admin's update approval; false when it could be activated at once",
  })
  serverGating!: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Required server-scope permissions a server admin has denied. They gate the update on an update approval, ' +
      'which grants them (#1336).',
  })
  deniedRequiredSlugs!: UpdateEscalationComparison['deniedRequiredSlugs'];

  @ApiProperty({ type: [String], description: 'Permission slugs each household must decide again' })
  householdReconsentSlugs!: UpdateEscalationComparison['householdReconsentSlugs'];

  @ApiProperty({
    type: [String],
    description: 'Server-scope permission slugs whose risk rose; the update approval decides them at the new risk',
  })
  serverRiskEscalatedSlugs!: UpdateEscalationComparison['serverRiskEscalatedSlugs'];

  @ApiProperty({ type: [String], description: 'Permission slugs each user must decide again' })
  userReconsentSlugs!: UpdateEscalationComparison['userReconsentSlugs'];
}

/** The plugin's row as the update approval left it: every column, as stored. */
export class PluginRowDto implements Plugin {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Manifest slug, the install identity every plugin route addresses' })
  slug!: string;

  @ApiProperty({ description: 'The active version' })
  version!: string;

  @ApiProperty({ enum: PluginCategory, enumName: 'PluginCategory' })
  category!: PluginCategory;

  @ApiProperty({ enum: PluginScope, enumName: 'PluginScope' })
  scope!: PluginScope;

  @ApiProperty({ enum: PluginExecutionMode, enumName: 'PluginExecutionMode' })
  executionMode!: PluginExecutionMode;

  @ApiProperty({ description: "The plugin's Server switch; each unit's own switch sits beneath it" })
  enabled!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The link the active plugin artifact was fetched from; null for an upload',
  })
  installedFromUrl!: string | null;

  @ApiProperty({ description: 'SHA-256 of the active plugin artifact' })
  installedSha256!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The registry source the active plugin artifact was discovered through',
  })
  registrySlug!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The active plugin manifest, as validated' })
  manifestJson!: Prisma.JsonValue;

  @ApiProperty({ type: 'object', additionalProperties: true, description: "The plugin's server-scope settings" })
  config!: Prisma.JsonValue;

  @ApiProperty({ description: 'True when the plugin failed to load at the last start' })
  loadFailed!: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'Why the plugin failed to load' })
  loadError!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The server admin who installed the plugin' })
  installedById!: string | null;

  @ApiProperty({ type: Date })
  installedAt!: Date;

  @ApiProperty({ description: 'Whether the server looks for newer releases of the plugin' })
  updateCheckEnabled!: boolean;

  @ApiProperty({ type: Date, nullable: true })
  lastUpdateCheckAt!: Date | null;

  @ApiProperty({ type: String, nullable: true, description: 'The newest release the update check found' })
  latestKnownVersion!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The release channel of that release' })
  latestKnownChannel!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Security advisory text for that release' })
  securityAdvisory!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The staged update’s version; null when none is staged' })
  pendingVersion!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'The staged update’s plugin manifest; null when none is staged',
  })
  pendingManifestJson!: Prisma.JsonValue | null;

  @ApiProperty({ type: String, nullable: true, description: 'SHA-256 of the staged update’s plugin artifact' })
  pendingSha256!: string | null;

  @ApiProperty({ type: Date, nullable: true, description: 'When the update was staged' })
  pendingSince!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The staging an update approval or a rejection must name',
  })
  pendingStagingId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The link the staged update’s plugin artifact was fetched from; null for an upload',
  })
  pendingFromUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The registry source the staged update’s plugin artifact was discovered through',
  })
  pendingRegistrySlug!: string | null;

  @ApiProperty({
    description: 'True when the server has recorded a version its running processes have not loaded yet',
  })
  restartRequired!: boolean;

  @ApiProperty({ type: Date, nullable: true, description: 'When the plugin was uninstalled; null while installed' })
  uninstalledAt!: Date | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date })
  updatedAt!: Date;
}

/** One server-scope decision the update approval recorded. */
export class PluginGrantRowDto implements PluginGrant {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  pluginId!: string;

  @ApiProperty({ enum: PluginGrantScope, enumName: 'PluginGrantScope' })
  scopeType!: PluginGrantScope;

  @ApiProperty({ description: 'The household or user id; empty for a server-scope decision' })
  scopeId!: string;

  @ApiProperty({ description: 'The permission decided' })
  permissionSlug!: string;

  @ApiProperty({ enum: PluginGrantStatus, enumName: 'PluginGrantStatus' })
  status!: PluginGrantStatus;

  @ApiProperty({ type: String, nullable: true, description: 'Who decided' })
  decidedById!: string | null;

  @ApiProperty({ description: 'The consent act that recorded the decision' })
  actId!: string;

  @ApiProperty({
    enum: RiskLevel,
    enumName: 'RiskLevel',
    description: "The permission's risk when it was decided",
  })
  decidedRiskLevel!: RiskLevel;

  @ApiProperty({ type: Date })
  decidedAt!: Date;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date })
  updatedAt!: Date;
}

class ReconsentHouseholdUnitDto implements PluginUpdateReconsentHouseholdUnit {
  @ApiProperty()
  householdId!: string;

  @ApiProperty({ type: [String], description: 'The permission slugs the household has not granted yet' })
  outstanding!: PluginUpdateReconsentHouseholdUnit['outstanding'];
}

class ReconsentUserUnitDto implements PluginUpdateReconsentUserUnit {
  @ApiProperty()
  userId!: string;

  @ApiProperty({ type: [String], description: 'The permission slugs the user has not granted yet' })
  outstanding!: PluginUpdateReconsentUserUnit['outstanding'];
}

/** The consent act an update approval records (#1336): its summary, not its stored presentation. */
class UpdateApproveActDto implements Pick<PluginConsentAct, 'id' | 'decidedAt'> {
  @ApiProperty({ description: 'The recorded consent act' })
  id!: string;

  @ApiProperty({ enum: [PluginConsentActKind.UpdateApprove], description: 'Which consent act this was' })
  kind!: typeof PluginConsentActKind.UpdateApprove;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the consent act was recorded' })
  decidedAt!: Date;
}

/** What an update approval answers (#321, #1096). */
export class ApprovePluginUpdateResponseDto {
  @ApiProperty({ description: 'Plain-language confirmation, localized. It names the process role to restart.' })
  message!: string;

  @ApiProperty({ type: PluginRowDto, description: "The plugin's row, with the update activated" })
  plugin!: PluginRowDto;

  @ApiProperty({ type: UpdateComparisonDto, description: 'The comparison the update approval was decided on' })
  comparison!: UpdateComparisonDto;

  @ApiProperty({
    type: UpdateApproveActDto,
    description: "The consent act the update approval recorded: the Server unit's consent to the update",
  })
  act!: UpdateApproveActDto;

  @ApiProperty({ type: [PluginGrantRowDto], description: 'The server-scope permissions the update approval granted' })
  seededGrants!: PluginGrantRowDto[];

  @ApiProperty({
    description: 'Always true after an update approval: nothing runs the new version until a restart',
  })
  restartRequired!: boolean;

  @ApiProperty({
    enum: PLUGIN_PROCESS_ROLES,
    isArray: true,
    description: 'The process roles to restart so the new version loads',
  })
  restartProcessRoles!: PluginProcessRole[];

  @ApiProperty({
    type: [ReconsentHouseholdUnitDto],
    description: 'Households that owe a fresh decision under the new version. They keep running meanwhile.',
  })
  reconsentHouseholdUnits!: ReconsentHouseholdUnitDto[];

  @ApiProperty({
    type: [ReconsentUserUnitDto],
    description: 'Users who owe a fresh decision under the new version. They keep running meanwhile.',
  })
  reconsentUserUnits!: ReconsentUserUnitDto[];
}

/** What staging an update from a plugin artifact answers, whether it was activated at once or staged (#1096). */
export class StagePluginUpdateResponseDto {
  @ApiProperty({
    description:
      'Plain-language confirmation, localized: the update is staged and waits for approval, or it is activated ' +
      'and loads when the named process role restarts, or the version is already active',
  })
  message!: string;

  @ApiProperty({
    description:
      'True when the plugin now runs the plugin artifact, at once or by an earlier request; false when the ' +
      'staged update waits for an update approval',
  })
  activated!: boolean;

  @ApiProperty({
    type: PluginInventoryDetailDto,
    description:
      'The plugin as the inventory serves it. A staged update shows under pendingUpdate, with the stagingId ' +
      'an update approval or a rejection must name.',
  })
  plugin!: PluginInventoryDetailDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'For a staged update that makes the plugin a data-gateway plugin: the name its DataGateway would take, ' +
      'when another DataGateway already has it. The update approval is refused until that DataGateway is ' +
      'renamed. Null once the update is activated.',
  })
  dataGatewayNameConflict!: string | null;
}
