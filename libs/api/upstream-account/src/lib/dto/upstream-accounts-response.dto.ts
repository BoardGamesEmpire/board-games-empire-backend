import { ApiProperty } from '@nestjs/swagger';
import { PRIVACY_POLICY_PATH } from '../upstream-account.constants';
import type { UpstreamKey } from '../upstream-keys';
import { UPSTREAM_KEY_VALUES, UpstreamAccountDto } from './upstream-account.dto';

/**
 * The privacy policy a client shows before a user links an upstream account
 * (#934, #935): where to read it, and which language and date the user would
 * read, so a client can tell a user the policy changed since they last saw it.
 */
export class UpstreamPrivacyPolicyDto {
  @ApiProperty({
    description: 'Where to read the policy. Ask for it with no `lang`, so it answers in the language below.',
    example: PRIVACY_POLICY_PATH,
  })
  url!: string;

  @ApiProperty({
    description:
      "The language tag the policy is in: the best match for the user's stored language, then `Accept-Language`, " +
      'or `en` when none matches.',
    example: 'en',
  })
  language!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When the policy in that language last changed, in ISO 8601, as `GET /api/privacy-policy` dates it.',
    example: '2026-11-18T00:00:00.000Z',
  })
  updatedAt!: string;
}

/** `GET /api/users/me/upstream-accounts`'s answer (#935). */
export class UpstreamAccountsResponseDto {
  @ApiProperty({
    type: [UpstreamAccountDto],
    description: 'Your upstream accounts, one per upstream at most, ordered by upstream.',
  })
  upstreamAccounts!: UpstreamAccountDto[];

  @ApiProperty({
    enum: UPSTREAM_KEY_VALUES,
    isArray: true,
    description:
      'The upstreams you can link an account at now, by key: those this server has a way to link that an ' +
      'enabled DataGateway serves. An account you already have stays in `upstreamAccounts` whether or not its ' +
      'upstream is listed here, and can always be unlinked.',
    example: ['steam'],
  })
  linkableUpstreams!: UpstreamKey[];

  @ApiProperty({ type: UpstreamPrivacyPolicyDto })
  privacyPolicy!: UpstreamPrivacyPolicyDto;
}
