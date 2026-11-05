import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** Shape-only validation: whether `stagingId` names the current staging is the service's call (#357). */
export class RejectPluginUpdateDto {
  @ApiProperty({
    description:
      'The staged update this rejection answers: `stagingId` from GET /plugins/:slug/update/pending. If another ' +
      'staging has replaced it since, the rejection answers 409 PluginUpdateStagingReplacedError and clears nothing.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  stagingId!: string;
}
