import { ApiProperty } from '@nestjs/swagger';

/**
 * The privacy policy as anyone reads it, signed in or not (#934): the text in
 * one language, with the date that text last changed. It never names who
 * edited it, a file path or a hash.
 */
export class PrivacyPolicyDto {
  @ApiProperty({
    description:
      'The language tag the policy is served in: the best match for `lang`, then `Accept-Language`, ' +
      'among `availableLanguages`, or `en` when none matches. The `Content-Language` header repeats it.',
    example: 'en',
  })
  language!: string;

  @ApiProperty({
    description:
      'The policy text as Markdown, sanitized as every Markdown the server stores is. Its headings and lists ' +
      'are kept, so a screen reader can move through it.',
    example: '# Privacy policy\n\nThis server keeps your account details so that you can sign in.\n',
  })
  markdown!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When the text served last changed, in ISO 8601: a server admin’s last edit, or the date in the ' +
      'policy file it comes from. Each language has its own date, so a change in another language does not ' +
      'move it. Treat any change of this date as an update, not only a later one: when a server admin ' +
      'removes their text for a language, the file’s text is served again with its own date, which can be ' +
      'earlier.',
    example: '2026-11-18T00:00:00.000Z',
  })
  updatedAt!: string;

  @ApiProperty({
    enum: ['standard', 'operator'],
    description:
      'Whether the text is the standard privacy policy the server ships, unchanged, or the operator’s privacy ' +
      'policy, which replaces it for this language.',
    example: 'standard',
  })
  source!: 'standard' | 'operator';

  @ApiProperty({
    type: [String],
    description: 'Every language tag the policy can be read in, sorted. Ask for one with `lang`.',
    example: ['de', 'en'],
  })
  availableLanguages!: string[];
}

/** `GET /api/privacy-policy`'s answer (#934). */
export class PrivacyPolicyResponseDto {
  @ApiProperty({ type: PrivacyPolicyDto })
  privacyPolicy!: PrivacyPolicyDto;
}
