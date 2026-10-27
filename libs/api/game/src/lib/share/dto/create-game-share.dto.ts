import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * `POST /games/:id/shares` (#810).
 *
 * Exactly one of `userId` and `householdId` names the recipient. That rule
 * spans two fields, so the service enforces it rather than a decorator, as the
 * household invite's create does. There is no `approvedAt`: whether a share
 * takes effect at once is the server's to decide, and the global pipe refuses
 * a field this class does not declare.
 */
export class CreateGameShareDto {
  @ApiPropertyOptional({ description: 'ID of a registered user to share the game with. Give this or `householdId`.' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  userId?: string;

  @ApiPropertyOptional({
    description: 'ID of a household you belong to, to share the game with its members. Give this or `userId`.',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  householdId?: string;
}
