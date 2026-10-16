import { AuthType, Prisma } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsPositive, IsString, Max } from 'class-validator';

export class CreateDataGatewayDto {
  @ApiProperty({ description: 'Unique name of the DataGateway' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;

  @ApiProperty({ description: 'URL for the DataGateway connection' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  connectionUrl!: string;

  @Type(() => Number)
  @ApiProperty({ description: 'Port number for the DataGateway connection' })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(65535, { message: i18nValidationMessage('validation.max') })
  connectionPort!: number;

  @Type(() => Boolean)
  @ApiPropertyOptional({ description: 'Indicates whether the DataGateway is enabled' })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  enabled?: boolean;

  @ApiProperty({ enum: AuthType, description: 'Authentication type for this DataGateway' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsIn(Object.values(AuthType), { message: i18nValidationMessage('validation.isIn') })
  authType!: AuthType;

  @ApiPropertyOptional({ description: 'Authentication parameters for this DataGateway' })
  @IsOptional()
  // TODO: Possible to validate this against the expected parameters for the given auth type?
  // Custom validator?
  authParameters?: Prisma.JsonValue;

  @ApiPropertyOptional({ description: 'A brief description of this DataGateway' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  description?: string;

  @ApiPropertyOptional({
    description: 'Message context for this DataGateway',
    example: 'JSON',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  messageContext?: string;

  @ApiPropertyOptional({ description: 'URL to an icon for this DataGateway' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  iconUrl?: string;

  @ApiPropertyOptional({ description: 'URL to the logo for this DataGateway' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  logoUrl?: string;

  @ApiPropertyOptional({ description: 'Website URL for this DataGateway' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  websiteUrl?: string;

  @ApiPropertyOptional({ description: 'Base URL for the DataGateway API, if applicable' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  apiBaseUrl?: string;

  @ApiPropertyOptional({ description: 'URL to API documentation for this DataGateway' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  apiDocumentation?: string;

  @ApiPropertyOptional({ description: 'Version of the API for this DataGateway' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  apiVersion?: string;
}
