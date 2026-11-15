import { RiskLevel } from '@bge/database';
import type { PluginCheckPresentation, PluginConsentPresentation, PluginFeaturePresentation } from '@bge/plugin';
import { ApiProperty } from '@nestjs/swagger';

/**
 * OpenAPI model for the consent surface (`GET …/consent`, #1150). As in
 * `plugin-inventory.response.ts`, every class that models a runtime shape
 * `implements` it, so a field the presentation service gains and this file
 * leaves out is a compile error here, not a client that cannot see it.
 */

class ResolvedTextDto {
  @ApiProperty({ description: 'The text, in the locale it was served from' })
  value!: string;

  @ApiProperty({ description: 'The locale the text was served from' })
  locale!: string;

  @ApiProperty({
    description:
      'True when neither the requested locale nor its base language had the text, so it is served in the ' +
      "server's default locale. A client can say so, or mark the text's language for a screen reader.",
  })
  usedFallback!: boolean;
}

class ConsentSurfacePluginDto implements Pick<PluginConsentPresentation['plugin'], 'id' | 'slug' | 'enabled'> {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Manifest slug' })
  slug!: string;

  @ApiProperty({
    description:
      'The server switch, shown for context: consent can be given while the plugin is switched off, and takes ' +
      'effect when it is switched on',
  })
  enabled!: boolean;
}

class ConsentSurfaceStagedUpdateDto implements NonNullable<PluginConsentPresentation['stagedUpdate']> {
  @ApiProperty({ description: 'The staged version' })
  manifestVersion!: string;

  @ApiProperty({
    description:
      'SHA-256 of the staged plugin artifact. Read the staged consent surface (manifest=staged) to pre-consent.',
  })
  manifestSha256!: string;
}

class ConsentSurfaceFeatureDto implements PluginFeaturePresentation {
  @ApiProperty({ description: 'Manifest features[].name, the stable identifier' })
  name!: string;

  @ApiProperty({ type: ResolvedTextDto })
  displayName!: ResolvedTextDto;

  @ApiProperty({ type: ResolvedTextDto })
  description!: ResolvedTextDto;
}

class ConsentSurfacePermissionDto implements PluginCheckPresentation {
  @ApiProperty({
    description: 'Canonical slug of the requested permission: plugin|<slug>|<bare> for one the plugin declares',
  })
  slug!: string;

  @ApiProperty({ enum: ['core', 'plugin'], description: 'core: a server permission. plugin: one the plugin declares.' })
  origin!: PluginCheckPresentation['origin'];

  @ApiProperty({ description: 'True when the plugin says it cannot work without this permission' })
  required!: boolean;

  @ApiProperty({ enum: ['server', 'household', 'user'], description: 'Who consents to this permission' })
  consentScope!: PluginCheckPresentation['consentScope'];

  @ApiProperty({ type: String, nullable: true, description: 'Manifest feature name; null for the whole plugin' })
  feature!: string | null;

  @ApiProperty({ description: 'True when the unit this surface was built for makes this consent decision' })
  decidableByUnit!: boolean;

  @ApiProperty({
    enum: ['granted', 'denied', 'pending', 'per-unit'],
    description:
      'The consent decision as this unit sees it. per-unit: each unit of another kind decides it for itself, so ' +
      'there is no single answer from here.',
  })
  decision!: PluginCheckPresentation['decision'];

  @ApiProperty({
    enum: RiskLevel,
    enumName: 'RiskLevel',
    nullable: true,
    description: "The permission's risk today; null when a core permission is not in the catalog",
  })
  riskLevel!: RiskLevel | null;

  @ApiProperty({
    enum: RiskLevel,
    enumName: 'RiskLevel',
    nullable: true,
    description: 'The risk recorded with the consent decision; null when none is recorded here',
  })
  decidedRiskLevel!: RiskLevel | null;

  @ApiProperty({ description: 'The recorded consent was given at a lower risk than today, so it must be given again' })
  staleRisk!: boolean;

  @ApiProperty({
    description:
      'False when consent at this consent scope could never confer the permission, so asking for it is pointless. ' +
      'Always true for a permission another kind of unit decides.',
  })
  grantable!: boolean;

  @ApiProperty({
    description:
      'Staged consent surface only: the active manifest does not request this permission at this consent scope, ' +
      'so no consent on record covers it yet. Always false on the active consent surface.',
  })
  stagedOnly!: boolean;

  @ApiProperty({ type: ResolvedTextDto, description: "The plugin's reason for requesting the permission" })
  reason!: ResolvedTextDto;
}

export class ConsentSurfaceDto implements PluginConsentPresentation {
  @ApiProperty({ type: ConsentSurfacePluginDto })
  plugin!: ConsentSurfacePluginDto;

  @ApiProperty({ description: 'Version of the manifest presented: the staged version on a staged consent surface' })
  manifestVersion!: string;

  @ApiProperty({
    enum: ['active', 'pending'],
    description: 'active: the manifest the plugin runs now. pending: the staged update waiting for the server admin.',
  })
  source!: PluginConsentPresentation['source'];

  @ApiProperty({
    description:
      'SHA-256 of the plugin artifact whose manifest is presented. A consent act names it, so consent is tied to ' +
      'what was shown.',
  })
  manifestSha256!: string;

  @ApiProperty({
    type: ConsentSurfaceStagedUpdateDto,
    nullable: true,
    description:
      'On the active consent surface: the staged update you can pre-consent to. Null when none is staged, ' +
      'and always null on a staged consent surface.',
  })
  stagedUpdate!: ConsentSurfaceStagedUpdateDto | null;

  @ApiProperty({
    type: 'object',
    properties: {
      scopeType: { type: 'string', enum: ['Server', 'Household', 'User'] },
      householdId: { type: 'string' },
      userId: { type: 'string' },
    },
    required: ['scopeType'],
    description: 'The unit the consent surface was built for',
  })
  unit!: PluginConsentPresentation['unit'];

  @ApiProperty({ type: ResolvedTextDto })
  displayName!: ResolvedTextDto;

  @ApiProperty({ type: ResolvedTextDto })
  description!: ResolvedTextDto;

  @ApiProperty({ type: [ConsentSurfaceFeatureDto] })
  features!: ConsentSurfaceFeatureDto[];

  @ApiProperty({
    type: [ConsentSurfacePermissionDto],
    description: 'Every requested permission, in manifest order',
  })
  checks!: ConsentSurfacePermissionDto[];
}

/** The route's body: the handler wraps the consent surface as `{ presentation: … }`. */
export class ConsentSurfaceResponseDto {
  @ApiProperty({ type: ConsentSurfaceDto })
  presentation!: ConsentSurfaceDto;
}
