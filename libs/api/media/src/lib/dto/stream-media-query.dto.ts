import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsNumberString, IsString } from 'class-validator';

/**
 * Query params on a signed GET URL. `op` is restricted to 'get' — signed PUT
 * uploads are deferred (multipart upload is the batch-3 path).
 */
export class StreamMediaQueryDto {
  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  slug!: string;

  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  key!: string;

  @ApiProperty({ enum: ['get'] })
  @IsIn(['get'], { message: i18nValidationMessage('validation.isIn') })
  op!: 'get';

  @ApiProperty({ description: 'Expiry as epoch seconds' })
  @IsNumberString(undefined, { message: i18nValidationMessage('validation.isNumberString') })
  exp!: string;

  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  sig!: string;
}
