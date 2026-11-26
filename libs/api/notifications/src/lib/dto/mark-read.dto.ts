import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { MAX_UNREAD_NOTIFICATIONS } from '../notifications.constants';

export class MarkReadDto {
  @ApiProperty({ type: [String], maxItems: MAX_UNREAD_NOTIFICATIONS })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayMaxSize(MAX_UNREAD_NOTIFICATIONS, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  notificationIds!: string[];
}
