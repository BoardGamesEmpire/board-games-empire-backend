import { AvailabilityResponse } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export class SubmitAvailabilityDto {
  @ApiProperty({ enum: AvailabilityResponse })
  @IsEnum(AvailabilityResponse)
  response!: AvailabilityResponse;
}
