import { MemberInvitePolicy } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsObject, IsOptional, ValidateNested } from 'class-validator';
import { CreateHouseholdDto } from './create-household.dto';

/**
 * A household's own settings (#166), as its owners and admins change them.
 * Each one is optional, so a patch names only the settings it changes.
 */
export class UpdateHouseholdSettingsDto {
  @ApiPropertyOptional({
    enum: MemberInvitePolicy,
    description:
      'Whether members may invite. `Direct`: their invites go straight to the invitee. `NeedsApproval` (the ' +
      'default): their invites wait for an owner or admin to approve them. `Off`: members cannot invite. Owners ' +
      'and admins always invite directly, and guests never invite. A change applies to invites sent after it.',
  })
  @IsOptional()
  @IsEnum(MemberInvitePolicy, { message: i18nValidationMessage('validation.isEnum') })
  memberInvitePolicy?: MemberInvitePolicy;
}

/**
 * Everything a create sets, less the create's own idempotency key, plus the
 * household's settings.
 *
 * `clientRequestId` is how a retried create finds the row it already made
 * (#210), so an edit that rewrote it would strand that retry into a second
 * household, and one that copied another of the creator's keys would trip the
 * `(createdById, clientRequestId)` unique (#534). Omitted rather than
 * ignored: under the global `forbidNonWhitelisted` pipe a PATCH carrying it
 * answers 400, and the published schema no longer offers it.
 */
export class UpdateHouseholdDto extends PartialType(OmitType(CreateHouseholdDto, ['clientRequestId'] as const)) {
  @ApiPropertyOptional({ type: UpdateHouseholdSettingsDto })
  @IsOptional()
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  @ValidateNested()
  @Type(() => UpdateHouseholdSettingsDto)
  settings?: UpdateHouseholdSettingsDto;
}
