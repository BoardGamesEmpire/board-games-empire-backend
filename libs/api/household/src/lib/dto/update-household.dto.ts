import { MemberInvitePolicy, MemberSharePolicy } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsObject, IsOptional, ValidateIf, ValidateNested } from 'class-validator';
import { CreateHouseholdDto, HouseholdReachProperty, type HouseholdReach } from './create-household.dto';

/**
 * A household's own settings (#166), as its owners and admins change them.
 * Each one is optional, so a patch names only the settings it changes.
 *
 * `ValidateIf` rather than `IsOptional`, which skips `null` as well as a
 * missing key: no setting can be unset, so `null` answers 400 here instead of
 * reaching the write.
 */
export class UpdateHouseholdSettingsDto {
  @ApiPropertyOptional({
    enum: MemberInvitePolicy,
    description:
      'Whether members may invite. `Direct`: their invites go straight to the invitee. `NeedsApproval` (the ' +
      'default): their invites wait for an owner or admin to approve them. `Off`: members cannot invite. Owners ' +
      'and admins always invite directly, and guests never invite. A change applies to invites sent after it, and ' +
      'a switch to `Off` also stops a waiting invite from being approved and an outstanding one from being accepted.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(MemberInvitePolicy, { message: i18nValidationMessage('validation.isEnum') })
  memberInvitePolicy?: MemberInvitePolicy;

  @ApiPropertyOptional({
    enum: MemberSharePolicy,
    description:
      'Whether members may share games they created with the household. `Direct`: their shares take effect at ' +
      'once. `NeedsApproval` (the default): their shares wait for an owner or admin to approve them. `Off`: ' +
      'members cannot share. Owners and admins always share directly, and guests never share. A change applies ' +
      'to shares made after it, and a switch to `Off` also stops a waiting share from being approved.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(MemberSharePolicy, { message: i18nValidationMessage('validation.isEnum') })
  memberSharePolicy?: MemberSharePolicy;
}

/**
 * Everything a create sets, less the create's own client request id, plus the
 * household's settings.
 *
 * `clientRequestId` is how a retried create finds the row it already made
 * (#210), so an edit that rewrote it would strand that retry into a second
 * household, and one that copied another of the creator's keys would trip the
 * `(createdById, clientRequestId)` unique (#534). Omitted rather than
 * ignored: under the global `forbidNonWhitelisted` pipe a PATCH carrying it
 * answers 400, and the published schema no longer offers it.
 */
export class UpdateHouseholdDto extends PartialType(
  OmitType(CreateHouseholdDto, ['clientRequestId', 'reach'] as const),
) {
  @HouseholdReachProperty()
  reach?: HouseholdReach;

  @ApiPropertyOptional({ type: UpdateHouseholdSettingsDto })
  @IsOptional()
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  @ValidateNested()
  @Type(() => UpdateHouseholdSettingsDto)
  settings?: UpdateHouseholdSettingsDto;
}
