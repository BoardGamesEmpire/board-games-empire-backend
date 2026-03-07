import { PaginationQueryDto } from '@bge/shared';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class UserSearchQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: 'Search term matched against username and first name', minLength: 2 })
  @IsString()
  @MinLength(2)
  q!: string;
}
