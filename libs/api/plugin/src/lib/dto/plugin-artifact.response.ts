import { RiskLevel } from '@bge/database';
import {
  PLUGIN_UPDATE_STAGING_REFUSALS,
  type PluginArtifactCheckPresentation,
  type PluginUpdateAssessment,
  type PluginUpdateChanges,
  type PluginUpdateDeclaresDiff,
  type PluginUpdateStagingRefusal,
  type StaticAnalysisFinding,
  type UpdateEscalationComparison,
} from '@bge/plugin';
import {
  ManifestWarningCode,
  PLUGIN_CATEGORIES,
  PLUGIN_CONSENT_SCOPES,
  PLUGIN_EXECUTION_MODES,
  PLUGIN_SCOPES,
  type ManifestWarning,
  type ResolvedLocalizedString,
} from '@boardgamesempire/plugin-manifest';
import { ApiProperty } from '@nestjs/swagger';
import { UpdateEscalationDto } from './plugin-update.response';

/**
 * OpenAPI models for the install ingress's artifact read (#1094). Each class
 * that models a runtime shape `implements` it, so a field the runtime adds is
 * a compile error here instead of a field the generated client cannot see.
 */

class ArtifactRowDto {
  @ApiProperty({ description: 'SHA-256 of the plugin artifact, lowercase. Install it by naming this.' })
  sha256!: string;

  @ApiProperty({ description: 'Slug of the plugin the artifact carries' })
  slug!: string;

  @ApiProperty({ description: 'Version of the plugin the artifact carries' })
  version!: string;

  @ApiProperty({ description: 'Size of the archive as received, in bytes' })
  compressedBytes!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The link it was downloaded from, without its query; null for an upload',
  })
  url!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The registry source it was discovered through' })
  registrySlug!: string | null;

  @ApiProperty({
    type: Date,
    description:
      'When the plugin artifact is thrown away if nobody has installed it: 7 days after it was posted or last read for an install',
  })
  expiresAt!: Date;
}

class ArtifactFeatureDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'Localized for the request' })
  displayName!: string;

  @ApiProperty({ description: 'Localized for the request' })
  description!: string;
}

class ArtifactManifestDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  version!: string;

  @ApiProperty({ description: 'Localized for the request' })
  displayName!: string;

  @ApiProperty({ description: 'Localized for the request' })
  description!: string;

  @ApiProperty({ enum: PLUGIN_CATEGORIES })
  category!: string;

  @ApiProperty({ enum: PLUGIN_SCOPES })
  scope!: string;

  @ApiProperty({ description: 'The BGE versions the plugin says it works with, as a semver range' })
  bgeCompat!: string;

  @ApiProperty({
    enum: PLUGIN_EXECUTION_MODES,
    description: 'The execution mode the manifest asks for; in-process when it names none',
  })
  executionMode!: string;

  @ApiProperty({
    oneOf: [
      { type: 'array', items: { type: 'string' } },
      { type: 'string', enum: ['configured'] },
    ],
    description: "The domains the plugin says it will reach, or 'configured' when a server admin supplies them",
  })
  outboundDomains!: string[] | 'configured';

  @ApiProperty({ type: [ArtifactFeatureDto] })
  features!: ArtifactFeatureDto[];
}

class ResolvedTextDto implements ResolvedLocalizedString {
  @ApiProperty()
  value!: string;

  @ApiProperty({ description: 'The locale the text was served from' })
  locale!: string;

  @ApiProperty({ description: 'True when the request locale had no text and another was served' })
  usedFallback!: boolean;
}

export class PluginArtifactCheckDto implements PluginArtifactCheckPresentation {
  @ApiProperty({ description: 'The permission slug the plugin asks for' })
  slug!: string;

  @ApiProperty({ enum: ['core', 'plugin'] })
  origin!: PluginArtifactCheckPresentation['origin'];

  @ApiProperty()
  required!: boolean;

  @ApiProperty({ enum: PLUGIN_CONSENT_SCOPES })
  consentScope!: PluginArtifactCheckPresentation['consentScope'];

  @ApiProperty({ type: String, nullable: true, description: 'The feature this permission belongs to' })
  feature!: string | null;

  @ApiProperty({ enum: RiskLevel, enumName: 'RiskLevel', nullable: true })
  riskLevel!: RiskLevel | null;

  @ApiProperty({ type: ResolvedTextDto, description: "The author's reason, localized for the request" })
  reason!: ResolvedTextDto;
}

// Keyed by every kind the runtime has, so a new kind fails to compile here.
const FINDING_KIND_KEYS = {
  'esm-import': true,
  'dynamic-import': true,
  'cjs-require': true,
  'declared-dependency': true,
  'lockfile-package': true,
  'non-literal-import': true,
  'non-literal-require': true,
  'read-failure': true,
  'parse-failure': true,
} satisfies Record<StaticAnalysisFinding['kind'], true>;

const FINDING_KINDS = Object.keys(FINDING_KIND_KEYS);

class AnalysisFindingDto implements StaticAnalysisFinding {
  @ApiProperty({ type: String, description: 'Path inside the plugin artifact' })
  file!: StaticAnalysisFinding['file'];

  @ApiProperty({ type: String, enum: FINDING_KINDS })
  kind!: StaticAnalysisFinding['kind'];

  @ApiProperty({ type: String, nullable: true })
  specifier!: string | null;

  @ApiProperty({ enum: ['forbidden', 'warning'] })
  severity!: StaticAnalysisFinding['severity'];

  @ApiProperty({ enum: ['default', 'deep'] })
  scanScope!: StaticAnalysisFinding['scanScope'];
}

class ArtifactAnalysisDto {
  @ApiProperty({ type: [AnalysisFindingDto] })
  findings!: AnalysisFindingDto[];

  @ApiProperty({ description: 'True when advisory findings were left out at the cap; gating findings never are' })
  truncated!: boolean;

  @ApiProperty()
  scannedFileCount!: number;
}

class ArtifactWarningDto implements ManifestWarning {
  @ApiProperty({ enum: ManifestWarningCode, enumName: 'ManifestWarningCode' })
  code!: ManifestWarningCode;

  @ApiProperty()
  path!: string;

  @ApiProperty()
  message!: string;
}

class InstalledPluginDto {
  @ApiProperty({
    enum: ['none', 'installed', 'uninstalled'],
    description: 'Whether a plugin with the artifact’s slug is installed, was uninstalled, or has never been installed',
  })
  state!: 'none' | 'installed' | 'uninstalled';

  @ApiProperty({ type: String, nullable: true, description: 'That plugin’s version; null when there is none' })
  version!: string | null;
}

class ArtifactUpdateDeclaresDto implements PluginUpdateDeclaresDiff {
  @ApiProperty({ type: [String], description: 'Plugin-namespaced permissions the update would declare' })
  added!: string[];

  @ApiProperty({
    type: [String],
    description: 'Plugin-namespaced permissions the update would stop declaring, and whose decisions it would delete',
  })
  removed!: string[];
}

/**
 * What staging the plugin artifact as an update would change. The comparison's
 * three parts sit beside the rest, spelled as `GET /plugins/:slug/update/pending`
 * spells them (#1096).
 */
class ArtifactUpdateChangesDto
  implements
    Omit<PluginUpdateChanges, 'comparison'>,
    Pick<UpdateEscalationComparison, 'escalations' | 'serverGating' | 'deniedRequiredSlugs'>
{
  @ApiProperty({
    description:
      'True when nothing needs an update approval: staging would activate the update at once, unless a server ' +
      'admin denies a permission it requires first, which stages it for approval instead',
  })
  activatesAtOnce!: boolean;

  // Typed off the runtime union, which UpdateEscalationDto documents.
  @ApiProperty({ type: [UpdateEscalationDto] })
  escalations!: UpdateEscalationComparison['escalations'];

  @ApiProperty({ description: "True when the update needs the server admin's update approval" })
  serverGating!: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Required server-scope permissions a server admin has denied. They gate the update on an update approval, ' +
      'which grants them (#1336).',
  })
  deniedRequiredSlugs!: string[];

  @ApiProperty({ type: ArtifactUpdateDeclaresDto })
  declares!: ArtifactUpdateDeclaresDto;

  @ApiProperty({
    type: [String],
    description: 'Permissions the update stops requesting, whose decisions activating it deletes at every scope',
  })
  noLongerRequested!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'For an update that makes the plugin a data-gateway plugin: the name its DataGateway would take, when ' +
      'another DataGateway already has it',
  })
  dataGatewayNameConflict!: string | null;
}

class ArtifactUpdateDto implements Omit<PluginUpdateAssessment, 'changes'> {
  @ApiProperty({ description: 'The version the installed plugin runs' })
  activeVersion!: string;

  @ApiProperty({
    enum: PLUGIN_UPDATE_STAGING_REFUSALS,
    nullable: true,
    description:
      'Why staging the plugin artifact as an update would be refused as things stand; null when it would not. ' +
      'active_version: it carries the version the plugin runs. staged_update_waiting: the plugin already has a staged ' +
      'update, which an update approval or a rejection must answer first. active_manifest_unreadable: the ' +
      "plugin's stored active manifest cannot be read. data_gateway_name_taken: the update would be activated at " +
      'once, and another DataGateway already has the name its DataGateway would take.',
  })
  refusal!: PluginUpdateStagingRefusal | null;

  @ApiProperty({
    type: ArtifactUpdateChangesDto,
    nullable: true,
    description:
      'Null when nothing can be compared: the plugin artifact carries the version the plugin runs, or the ' +
      "plugin's stored active manifest cannot be read",
  })
  changes!: ArtifactUpdateChangesDto | null;
}

/**
 * What posting a plugin artifact, and reading it back, answer: the artifact,
 * what its manifest says, and everything installing it would ask the server
 * admin to confirm. Every localized field is resolved for the request.
 */
export class PluginArtifactResponseDto {
  @ApiProperty({ type: ArtifactRowDto })
  artifact!: ArtifactRowDto;

  @ApiProperty({ type: ArtifactManifestDto })
  manifest!: ArtifactManifestDto;

  @ApiProperty({
    type: [PluginArtifactCheckDto],
    description: 'Every permission the plugin asks for, in manifest order',
  })
  checks!: PluginArtifactCheckDto[];

  @ApiProperty({
    description:
      'The one locale this server rendered the read in, a tag it supports. Send it back as `locale` when ' +
      "installing, so the install's consent act records the text that was read. Not a list: a reason reports its " +
      "own `locale`, the key of the plugin's text it came from, which falls back when the plugin has none in this one.",
  })
  locale!: string;

  @ApiProperty({
    type: [String],
    description:
      'Critical permission slugs to re-enter as `confirmCriticalSlugs` when installing. They apply to an install ' +
      'only: an update asks for its Critical permissions at the update approval.',
  })
  criticalSlugsToReenter!: string[];

  @ApiProperty({
    type: [String],
    description: 'Forbidden imports to re-enter as `acknowledgeForbiddenImports` when installing',
  })
  forbiddenImportsToAccept!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "For a data-gateway plugin: the name its DataGateway would take, from the plugin's display name in the " +
      'server default locale, when another DataGateway already has it. Installing is refused until that ' +
      "DataGateway is renamed. Deleting it doesn't free the name, and a deleted DataGateway can't be renamed. " +
      'Null when the install would not create a DataGateway under a taken name: for a plugin of another ' +
      'category, for a plugin already installed, and for a reinstall of a plugin that already has its DataGateway',
  })
  dataGatewayNameConflict!: string | null;

  @ApiProperty({ type: ArtifactAnalysisDto })
  analysis!: ArtifactAnalysisDto;

  @ApiProperty({
    type: [ArtifactWarningDto],
    description: 'Author guidance from manifest validation; it never blocks an install',
  })
  warnings!: ArtifactWarningDto[];

  @ApiProperty({ type: InstalledPluginDto })
  installedPlugin!: InstalledPluginDto;

  @ApiProperty({
    type: ArtifactUpdateDto,
    nullable: true,
    description:
      'What staging the plugin artifact as an update of the installed plugin with its slug would do. Null when ' +
      'no living plugin has the slug: none was installed, or it was uninstalled.',
  })
  update!: ArtifactUpdateDto | null;
}
