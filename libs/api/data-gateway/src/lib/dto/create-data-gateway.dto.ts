import { AuthType, Prisma } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsPositive, IsString, Max } from 'class-validator';

/**
 * Creates a remote DataGateway. A plugin DataGateway's row comes from
 * installing its plugin, never from this body, which has no `pluginId` (#1083).
 * `UpdateDataGatewayDto` inherits these descriptions, so the connection
 * fields' descriptions also say what an update does with them.
 */
export class CreateDataGatewayDto {
  @ApiProperty({ description: 'Unique name of the DataGateway' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;

  @ApiProperty({
    description:
      "URL for a remote DataGateway's connection. A plugin DataGateway has none, and an update to its row " +
      'refuses this field (#1083).',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  connectionUrl!: string;

  @Type(() => Number)
  @ApiProperty({
    description:
      "Port number for a remote DataGateway's connection. A plugin DataGateway has none, and an update to its " +
      'row refuses this field (#1083).',
  })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(65535, { message: i18nValidationMessage('validation.max') })
  connectionPort!: number;

  @Type(() => Boolean)
  @ApiPropertyOptional({ description: 'Indicates whether the DataGateway is enabled' })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  enabled?: boolean;

  @ApiProperty({
    enum: AuthType,
    description:
      'Authentication type for a remote DataGateway. A plugin DataGateway has none, and an update to its row ' +
      'refuses this field (#1083).',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsIn(Object.values(AuthType), { message: i18nValidationMessage('validation.isIn') })
  authType!: AuthType;

  @ApiPropertyOptional({
    description:
      'Authentication parameters for a remote DataGateway. On an update, null leaves the stored ones as they ' +
      'are. A plugin DataGateway has none, and an update to its row refuses this field, null included (#1083).',
  })
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
