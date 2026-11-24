import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, NotContains, ValidateIf } from 'class-validator';
import type { RequestedScope } from '../key-scope-request';
import { asSent } from './as-sent';

/**
 * One key scope a create or edit names (#1418): a permission's slug, and a
 * row to pin it to. The server takes the resource type from the permission,
 * so a request never names one, and the global pipe refuses any other key.
 */
export class RequestedScopeDto implements RequestedScope {
  @ApiProperty({
    description:
      "The permission's stable name, such as read:game, as GET /api/api-keys/grantable lists it. One the catalog " +
      'lacks, or one you may not hand a key, is refused.',
  })
  @asSent
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  slug!: string;

  @ApiPropertyOptional({
    description:
      'The one record the key scope reaches, by id. Left out, the key scope reaches every record your own ' +
      'permissions reach. Only a permission whose grantable entry says pinnable takes one.',
  })
  @asSent
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  resourceId?: string;
}
