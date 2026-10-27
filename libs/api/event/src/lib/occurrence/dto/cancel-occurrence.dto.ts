import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { EVENT_CANCEL_MAX_REASON_LENGTH } from '../../constants/event-cancel.constant';

/** `POST /events/:eventId/occurrences/:occurrenceId/cancel` (#795). */
export class CancelOccurrenceDto {
  @ApiPropertyOptional({
    description: 'Why the date is cancelled. The event itself stays on, and the host may pick another date.',
    maxLength: EVENT_CANCEL_MAX_REASON_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(EVENT_CANCEL_MAX_REASON_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  reason?: string;
}
