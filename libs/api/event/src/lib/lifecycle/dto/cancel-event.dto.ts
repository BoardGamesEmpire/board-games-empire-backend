import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { EVENT_CANCEL_MAX_REASON_LENGTH } from '../../constants/event-cancel.constant';

/** `POST /events/:id/cancel` (#795). */
export class CancelEventDto {
  @ApiPropertyOptional({
    description:
      "Why the event is called off. Every attendee's notification carries it, and its dates are cancelled with it.",
    maxLength: EVENT_CANCEL_MAX_REASON_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(EVENT_CANCEL_MAX_REASON_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  reason?: string;
}
