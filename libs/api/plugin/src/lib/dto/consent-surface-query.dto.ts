import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/** Which manifest a household or user consent surface presents (#1150). */
export const CONSENT_SURFACE_MANIFESTS = ['active', 'staged'] as const;
export type ConsentSurfaceManifest = (typeof CONSENT_SURFACE_MANIFESTS)[number];

/**
 * Query for the household and user consent surface (#1150). `staged` serves
 * the staged update's consent surface, so a unit can pre-consent before the
 * operator approves the update; the operator's own consent surface takes no
 * query.
 */
export class ConsentSurfaceQueryDto {
  @ApiPropertyOptional({
    enum: CONSENT_SURFACE_MANIFESTS,
    default: 'active',
    description:
      'active: the manifest the plugin runs now. staged: the update waiting for the server admin, so you can ' +
      'consent ahead of it; 404 when no update is waiting.',
  })
  @IsIn(CONSENT_SURFACE_MANIFESTS, { message: i18nValidationMessage('validation.isIn') })
  @IsOptional()
  manifest?: ConsentSurfaceManifest;
}
