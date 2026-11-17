import { i18nValidationMessage } from '@bge/i18n';
import { TransformBoolean } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { CONSENT_ACT_LOCALE_MAX_LENGTH } from './consent-act.dto';
import { PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH } from './post-plugin-artifact.dto';

/**
 * Shape-only validation, as on the staged update's approval: whether the sets
 * are the RIGHT sets is the installer's call, and a wrong set comes back as a
 * 409 challenge carrying what it expected (#1094).
 */
export class InstallPluginDto {
  @ApiProperty({
    description:
      'The checksum of a plugin artifact that was posted and has not expired or been installed, 64 hexadecimal ' +
      'characters in either case.',
    maxLength: PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH,
  })
  @MaxLength(PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  sha256!: string;

  @ApiPropertyOptional({
    description:
      'Exact re-entry of every Critical permission slug the install will grant: the `criticalSlugsToReenter` ' +
      'the artifact read reported.',
    type: [String],
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @IsOptional()
  confirmCriticalSlugs?: string[];

  @ApiPropertyOptional({
    description:
      'Exact re-entry of every forbidden import static analysis found: the `forbiddenImportsToAccept` the ' +
      'artifact read reported.',
    type: [String],
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @IsOptional()
  acknowledgeForbiddenImports?: string[];

  @ApiPropertyOptional({
    description: 'Also scan node_modules. Its findings only advise; they never block the install.',
    default: false,
  })
  // As on the uninstall body: the global pipe's implicit conversion would turn
  // a form-encoded `false` into true.
  @TransformBoolean()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  deepScan?: boolean;

  @ApiPropertyOptional({
    description:
      "The locale the artifact's read was requested in, one of the locales this server supports. Not the locale " +
      "a reason reports, which names the plugin's own text the reason came from. The install's consent act " +
      'records its presentation in this locale, so it holds the text that was read. Without it, the request ' +
      "locale is used. The match is exact, since the supported tags are the server's own spelling; a locale this " +
      'server does not support answers 422 PLUGIN_CONSENT_ACT_LOCALE (#1301).',
    maxLength: CONSENT_ACT_LOCALE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(CONSENT_ACT_LOCALE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  locale?: string;
}
