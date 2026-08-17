import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/**
 * The payload shape is manifest-defined, so the config rides under one
 * declared `config` property: the global pipe's `forbidNonWhitelisted`
 * strips undeclared TOP-LEVEL properties, and nesting keeps it from
 * stripping the plugin's own keys. Semantic validation — the manifest's
 * `config.schema` — happens in the runtime service, not here.
 */
export class UpdatePluginConfigDto {
  @ApiProperty({
    description: "The full server-scope configuration object, validated against the plugin manifest's config.schema",
    type: 'object',
    additionalProperties: true,
  })
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  config!: Record<string, unknown>;
}
