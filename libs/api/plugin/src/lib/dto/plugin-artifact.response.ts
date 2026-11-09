import { RiskLevel } from '@bge/database';
import type { PluginArtifactCheckPresentation, StaticAnalysisFinding } from '@bge/plugin';
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
    type: [String],
    description: 'Critical permission slugs to re-enter as `confirmCriticalSlugs` when installing',
  })
  criticalSlugsToReenter!: string[];

  @ApiProperty({
    type: [String],
    description: 'Forbidden imports to re-enter as `acknowledgeForbiddenImports` when installing',
  })
  forbiddenImportsToAccept!: string[];

  @ApiProperty({ type: ArtifactAnalysisDto })
  analysis!: ArtifactAnalysisDto;

  @ApiProperty({
    type: [ArtifactWarningDto],
    description: 'Author guidance from manifest validation; it never blocks an install',
  })
  warnings!: ArtifactWarningDto[];

  @ApiProperty({ type: InstalledPluginDto })
  installedPlugin!: InstalledPluginDto;
}
