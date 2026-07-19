import { AvailabilityResponse } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export class SubmitAvailabilityDto {
  @ApiProperty({ enum: AvailabilityResponse })
  @IsEnum(AvailabilityResponse, { message: i18nValidationMessage('validation.isEnum') })
  response!: AvailabilityResponse;
}
