import { Type } from 'class-transformer';
import { IsOptional, IsPositive, Min } from 'class-validator';

export class PaginationQueryDto {
  @Type(() => Number)
  @IsPositive()
  @IsOptional()
  limit!: number;

  @Type(() => Number)
  @Min(0)
  @IsOptional()
  offset = 0;
}
