import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, NotContains, ValidateIf } from 'class-validator';
import { asSent } from './update-permission.dto';

/**
 * The Owner's edit to one role (#772): its description, the one thing about a
 * role the Owner changes here. Its grants have their own routes, and its name
 * is what every condition and the server's own code know it by. The edit
 * marks the role as the Owner's, so the next start keeps the description.
 *
 * `description` is required, and `null` clears it. It is validated as sent,
 * like `UpdatePermissionDto.reason`: the global pipe's implicit conversion
 * would make 5 into '5' and an object into '[object Object]'.
 */
export class UpdateRoleDto {
  @ApiProperty({
    description: 'What the role is for, in a sentence. Null clears it.',
    type: String,
    nullable: true,
  })
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  @Transform(asSent)
  description!: string | null;
}
