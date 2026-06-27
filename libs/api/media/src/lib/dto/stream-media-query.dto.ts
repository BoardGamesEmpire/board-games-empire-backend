import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsNumberString, IsString } from 'class-validator';

/**
 * Query params on a signed GET URL. `op` is restricted to 'get' — signed PUT
 * uploads are deferred (multipart upload is the batch-3 path).
 */
export class StreamMediaQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ enum: ['get'] })
  @IsIn(['get'])
  op!: 'get';

  @ApiProperty({ description: 'Expiry as epoch seconds' })
  @IsNumberString()
  exp!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  sig!: string;
}
