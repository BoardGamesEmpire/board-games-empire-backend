import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

/**
 * `PATCH /households/:householdId/members/me` (#170): turns the caller's
 * collection sharing with this household on or off.
 */
export class UpdateCollectionSharingDto {
  @ApiProperty({
    type: Boolean,
    description:
      'Whether your games join this household’s game pool. Excluded games stay out either way. ' +
      'A JSON boolean: the strings "true" and "false" are refused.',
  })
  // Read as sent: the global pipe's implicit conversion turns any non-empty
  // string into true, so the string 'false' would turn collection sharing on.
  // Left as sent, anything but a JSON boolean fails IsBoolean (#170).
  @Transform(({ obj, key }: { key: string; obj: Record<string, unknown> }) => obj[key])
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  collectionSharing!: boolean;
}
