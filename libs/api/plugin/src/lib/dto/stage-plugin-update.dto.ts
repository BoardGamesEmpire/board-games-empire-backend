import { i18nValidationMessage } from '@bge/i18n';
import { TransformBoolean } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH } from './post-plugin-artifact.dto';

/**
 * Shape-only validation, as on the install body: whether the acknowledgement
 * is the RIGHT set is the staging's call, and a wrong set comes back as a 409
 * challenge carrying what it expected (#1096).
 *
 * The three properties are validated exactly as `InstallPluginDto` validates
 * them but are declared here again, not shared through a base class: their
 * descriptions speak of an install there and of a staged update here, and a
 * base class would also move `InstallPluginDto`'s documented properties out of
 * their order.
 */
export class StagePluginUpdateDto {
  @ApiProperty({
    description:
      'The checksum of a plugin artifact that was posted for this plugin and has not expired, 64 hexadecimal ' +
      'characters in either case.',
    maxLength: PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH,
  })
  @MaxLength(PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  sha256!: string;

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
    description: 'Also scan node_modules. Its findings only advise; they never block the staged update.',
    default: false,
  })
  // As on the install body: the global pipe's implicit conversion would turn
  // a form-encoded `false` into true.
  @TransformBoolean()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  deepScan?: boolean;
}
