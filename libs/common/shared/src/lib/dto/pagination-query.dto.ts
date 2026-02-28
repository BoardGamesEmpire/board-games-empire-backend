import { IsOptional, IsPositive, Min } from 'class-validator';

export class PaginationQueryDto {
  @IsPositive()
  @IsOptional()
  limit = 10;

  @Min(0)
  @IsOptional()
  offset = 0;
}
