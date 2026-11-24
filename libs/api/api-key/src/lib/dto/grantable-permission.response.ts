import { RiskLevel } from '@bge/database';
import type { I18nMessage } from '@bge/i18n';
import type { GrantablePermission } from '@bge/permissions';
import { ApiProperty } from '@nestjs/swagger';
import { permissionDescription } from '../permission-description';

/** One permission the signed-in user's API key may hold, as the key creation screen lists it (#1417). */
export class GrantablePermissionResponse {
  @ApiProperty({ description: "The permission's stable name, such as read:game." })
  slug!: string;

  @ApiProperty({
    description:
      'What the permission lets a key do, in plain language and in the language of the request. A screen reader ' +
      'announces it on the key creation screen.',
  })
  description!: string;

  @ApiProperty({
    enum: RiskLevel,
    enumName: 'RiskLevel',
    description:
      'How dangerous the permission is to hand over: Low, Medium, High or Critical. A permission is offered at ' +
      'every level.',
  })
  riskLevel!: RiskLevel;

  @ApiProperty({
    description:
      'Whether a key scope over this permission can be limited to one record. A create permission never can, ' +
      'because the record does not exist yet.',
  })
  pinnable!: boolean;
}

/** `GET /api/api-keys/grantable`'s body (#1417). */
export class GrantablePermissionsResponse {
  @ApiProperty({
    type: [GrantablePermissionResponse],
    description:
      'Every permission you hold now that a key of yours may hold, sorted by permission slug. The list is not ' +
      'paged, because the permission catalog bounds it.',
  })
  permissions!: GrantablePermissionResponse[];
}

/**
 * An entry as the controller returns it: a plain object whose description is
 * still a translation marker, which the response interceptor renders in the
 * request's language. The interceptor walks plain objects only, so this is
 * never a class instance (#1417).
 */
export interface GrantablePermissionEntry {
  readonly description: I18nMessage;
  readonly pinnable: boolean;
  readonly riskLevel: RiskLevel;
  readonly slug: string;
}

/** The wire shape of one grantable permission, its description left for the edge to translate (#1417). */
export function toGrantablePermissionEntry({
  slug,
  riskLevel,
  pinnable,
}: GrantablePermission): GrantablePermissionEntry {
  return { slug, description: permissionDescription(slug), riskLevel, pinnable };
}
