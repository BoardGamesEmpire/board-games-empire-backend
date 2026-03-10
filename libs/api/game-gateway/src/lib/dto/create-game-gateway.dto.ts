import { AuthType, Prisma } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsPositive, IsString, Max } from 'class-validator';

export class CreateGameGatewayDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty()
  @IsString()
  connectionUrl!: string;

  @Type(() => Number)
  @ApiProperty()
  @IsPositive()
  @Max(65535)
  connectionPort!: number;

  @Type(() => Boolean)
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean = true;

  @ApiProperty({ enum: AuthType })
  @IsString()
  @IsIn(Object.values(AuthType))
  authType!: AuthType;

  @ApiPropertyOptional()
  @IsOptional()
  // TODO: Possible to validate this against the expected parameters for the given auth type?
  // Custom validator?
  authParameters?: Prisma.JsonValue;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  messageContent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  websiteUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  apiBaseUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  apiDocumentationUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  apiVersion?: string;
}
