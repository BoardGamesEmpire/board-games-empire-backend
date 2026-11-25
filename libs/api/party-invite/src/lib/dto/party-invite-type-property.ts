import { i18nValidationMessage } from '@bge/i18n';
import { CONTEXTUAL_INVITE_TYPES } from '@bge/invites';
import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/** What `?type=` says in the API document, for the inbox and the sent list alike. */
export const PARTY_INVITE_TYPE_DESCRIPTION =
  '`?type=` keeps only invites of one kind. Each row carries its `type`, so a list without the filter can tell them apart.';

/**
 * `?type=` on the inbox and the sent list alike (#742): one kind of invite of
 * those the party routes serve. A System or Campaign invite has no party
 * route, so filtering to one is a 400 rather than an empty page.
 */
export function PartyInviteTypeProperty(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({ enum: CONTEXTUAL_INVITE_TYPES, description: PARTY_INVITE_TYPE_DESCRIPTION }),
    IsOptional(),
    IsIn(CONTEXTUAL_INVITE_TYPES, { message: i18nValidationMessage('validation.isIn') }),
  );
}
