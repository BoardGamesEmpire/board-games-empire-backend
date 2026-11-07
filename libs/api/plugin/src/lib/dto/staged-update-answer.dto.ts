import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * What approving and rejecting a staged update share: both answer one staging,
 * named by its `stagingId`, so it is declared once (#1118). Shape-only
 * validation: whether `stagingId` names the current staging is the service's
 * call (#357).
 */
export abstract class StagedUpdateAnswerDto {
  @ApiProperty({
    description:
      'The staged update this answer (approval or rejection) addresses: `stagingId` from ' +
      'GET /plugins/:slug/update/pending. If another staging has replaced it since, the answer is 409 ' +
      'PluginUpdateStagingReplacedError and nothing is activated or cleared.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  stagingId!: string;
}
