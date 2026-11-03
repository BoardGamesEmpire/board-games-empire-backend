import { ResourceType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { TransformList } from '@bge/shared';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn } from 'class-validator';

/** The query for `GET /users/me/access` (#757). */
export class UserAccessQueryDto {
  @ApiProperty({
    description: 'Comma-separated or repeated resource types to answer for. Each one named is answered once.',
    enum: ResourceType,
    enumName: 'ResourceType',
    isArray: true,
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  // `?resourceTypes=` reads as [], which would answer nothing at all (#757).
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @IsIn(Object.values(ResourceType), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  resourceTypes!: ResourceType[];
}
