import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { DefaultPaginationQueryDto } from './capped-pagination-query.dto';

export class SearchQueryDto extends DefaultPaginationQueryDto {
  @ApiProperty({ description: 'Search terms matched against resource fields', minLength: 2 })
  @IsString()
  @MinLength(2)
  q!: string;
}
