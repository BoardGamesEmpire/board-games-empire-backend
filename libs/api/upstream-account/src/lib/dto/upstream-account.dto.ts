import type { UpstreamAccount } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';
import type { UpstreamKey } from '../upstream-keys';
import { UPSTREAM_KEY_VALUES, UPSTREAM_KEYS } from '../upstream-keys';

/**
 * One of the user's own upstream accounts, as `users/me/upstream-accounts`
 * answers it (#935). It never carries the row's id or the user's id: the
 * upstream names the account, since a user has one per upstream.
 */
export class UpstreamAccountDto {
  @ApiProperty({
    enum: UPSTREAM_KEY_VALUES,
    description: 'The upstream the account is at, by its well-known key. Unlink it with this key.',
    example: 'steam',
  })
  upstream!: UpstreamKey;

  @ApiProperty({
    description: "The upstream's own id for the account: a SteamID, a BoardGameGeek username.",
    example: '76561197960287930',
  })
  externalId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The name the account goes by at the upstream, or null until a DataGateway has looked it up.',
    example: null,
  })
  displayName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The address of the account's profile at the upstream, or null when there is none.",
    example: 'https://steamcommunity.com/profiles/76561197960287930',
  })
  profileUrl!: string | null;

  @ApiProperty({
    description:
      'Whether the upstream itself vouched for the account, as Steam sign-in does. A verified account belongs ' +
      'to one user on this server.',
    example: true,
  })
  verified!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When the account was linked, in ISO 8601.',
    example: '2026-11-19T10:00:00.000Z',
  })
  linkedAt!: string;
}

/** An upstream account row as its answer shows it. */
export function toUpstreamAccountDto(account: UpstreamAccount): UpstreamAccountDto {
  return {
    upstream: UPSTREAM_KEYS[account.upstream],
    externalId: account.externalId,
    displayName: account.displayName,
    profileUrl: account.profileUrl,
    verified: account.verified,
    linkedAt: account.createdAt.toISOString(),
  };
}
