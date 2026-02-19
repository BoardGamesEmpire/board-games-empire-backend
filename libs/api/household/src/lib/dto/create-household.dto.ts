import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateHouseholdDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  description!: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  image!: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  languageId!: string;
}
