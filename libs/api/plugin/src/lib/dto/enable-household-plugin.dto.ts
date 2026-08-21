import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, ValidateIf } from 'class-validator';

/**
 * Household enable with optional inline config (#323). Nested under one
 * declared `config` property for the same two reasons as the config PATCH:
 * the global pipe's `forbidNonWhitelisted` strips undeclared TOP-LEVEL
 * properties (nesting protects the plugin's own keys), and author-defined
 * schema keys must never collide with this DTO's root. Semantic
 * validation — the manifest's `config.schema` — happens in the runtime
 * service, not here.
 */
export class EnableHouseholdPluginDto {
  @ApiPropertyOptional({
    description:
      "Household configuration written atomically with the enable, validated against the manifest's config.schema. " +
      'Required in effect when the manifest declares requiresHouseholdConfig and no valid retained config exists (409 otherwise).',
    type: 'object',
    additionalProperties: true,
  })
  // ValidateIf, not @IsOptional: @IsOptional also waves NULL through, and
  // the service treats "present" as `!== undefined` — a null would reach
  // Prisma's non-nullable Json column as a 500. Only true absence skips.
  @ValidateIf((dto: EnableHouseholdPluginDto) => dto.config !== undefined)
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  config?: Record<string, unknown>;
}
