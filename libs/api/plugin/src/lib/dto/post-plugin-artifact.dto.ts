import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The receiver keeps client values in the errors it raises (a value that is not
 * a checksum comes back as `expectedSha256`), so every client string is capped
 * at the edge (#1094). The receiver trims and lowercases the checksum before it
 * compares, so the cap counts what the client sent.
 */
export const PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH = 128;
export const PLUGIN_ARTIFACT_URL_MAX_LENGTH = 2048;

/**
 * The JSON half of `POST /plugins/artifacts`; the upload is the multipart half,
 * whose `file` part multer takes before this is validated. Shape-only: whether
 * exactly one of link and file arrived is the handler's call, and whether the
 * checksum is one is the receiver's.
 */
export class PostPluginArtifactDto {
  @ApiProperty({
    description:
      'The SHA-256 checksum the plugin artifact must have, 64 hexadecimal characters in either case. The server ' +
      'refuses the plugin artifact, and keeps nothing of it, if its bytes have another checksum.',
    maxLength: PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH,
  })
  @MaxLength(PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  sha256!: string;

  @ApiPropertyOptional({
    description:
      'An http or https address to download the plugin artifact from, with no username or password in it. Send it ' +
      'or a `file`, not both. The server downloads from the whole link but records it without its query or ' +
      'fragment, where a presigned link keeps its token.',
    maxLength: PLUGIN_ARTIFACT_URL_MAX_LENGTH,
  })
  @MaxLength(PLUGIN_ARTIFACT_URL_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  url?: string;
}
