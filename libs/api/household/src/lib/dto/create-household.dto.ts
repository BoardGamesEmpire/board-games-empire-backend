import { Visibility } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateHouseholdDto {
  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;

  @ApiPropertyOptional({ enum: Visibility, description: "Set to 'Friends' to let members' friends view this household" })
  @IsOptional()
  @IsEnum(Visibility, { message: i18nValidationMessage('validation.isEnum') })
  visibility?: Visibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  image?: string;

  @ApiPropertyOptional({ description: "IETF BCP 47 language tag, e.g. 'en', 'pt-BR', 'zh-Hant'" })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  language?: string;
}
