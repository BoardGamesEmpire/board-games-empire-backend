import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AddGameToListDto {
  @ApiProperty({ description: 'ID of a GameCollection entry owned by the attendee' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  collectionId!: string;
}
