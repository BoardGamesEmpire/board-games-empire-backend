import { AuthType, Prisma } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsPositive, IsString, Max } from 'class-validator';

export class CreateGameGatewayDto {
  @ApiProperty({ description: 'Unique name of the game gateway' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'URL for the game gateway connection' })
  @IsString()
  connectionUrl!: string;

  @Type(() => Number)
  @ApiProperty({ description: 'Port number for the game gateway connection' })
  @IsPositive()
  @Max(65535)
  connectionPort!: number;

  @Type(() => Boolean)
  @ApiPropertyOptional({ description: 'Indicates whether the game gateway is enabled' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ enum: AuthType, description: 'Authentication type for this game gateway' })
  @IsString()
  @IsIn(Object.values(AuthType))
  authType!: AuthType;

  @ApiPropertyOptional({ description: 'Authentication parameters for this game gateway' })
  @IsOptional()
  // TODO: Possible to validate this against the expected parameters for the given auth type?
  // Custom validator?
  authParameters?: Prisma.JsonValue;

  @ApiPropertyOptional({ description: 'A brief description of this game gateway' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Message context for this game gateway',
    example: 'JSON',
  })
  @IsOptional()
  @IsString()
  messageContext?: string;

  @ApiPropertyOptional({ description: 'URL to an icon for this game gateway' })
  @IsOptional()
  @IsString()
  iconUrl?: string;

  @ApiPropertyOptional({ description: 'URL to the logo for this game gateway' })
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional({ description: 'Website URL for this game gateway' })
  @IsOptional()
  @IsString()
  websiteUrl?: string;

  @ApiPropertyOptional({ description: 'Base URL for the game gateway API, if applicable' })
  @IsOptional()
  @IsString()
  apiBaseUrl?: string;

  @ApiPropertyOptional({ description: 'URL to API documentation for this game gateway' })
  @IsOptional()
  @IsString()
  apiDocumentation?: string;

  @ApiPropertyOptional({ description: 'Version of the API for this game gateway' })
  @IsOptional()
  @IsString()
  apiVersion?: string;
}
