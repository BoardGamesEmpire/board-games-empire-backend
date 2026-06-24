import { PaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class LanguageQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter languages by name (case-insensitive, partial match)' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Filter languages by whether they are supported by the system' })
  @IsBoolean()
  @TransformBoolean()
  @IsOptional()
  systemSupported?: boolean;
}
