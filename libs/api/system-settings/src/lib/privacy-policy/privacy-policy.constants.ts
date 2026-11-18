/**
 * The most characters a privacy policy's Markdown may have, before it is
 * sanitized: a policy file's body and a server admin's replacement alike
 * (#934). The sanitizer keeps longer Markdown as plain text with its markup
 * shown, which would flatten the headings and lists a screen reader moves by.
 */
export const PRIVACY_POLICY_MAX_LENGTH = 20_000;

/**
 * Where the privacy policy served in a language comes from (#934): the
 * standard privacy policy the server ships, unchanged, or the operator's
 * privacy policy, which replaces it.
 */
export const PRIVACY_POLICY_SOURCES = ['standard', 'operator'] as const;

export type PrivacyPolicySource = (typeof PRIVACY_POLICY_SOURCES)[number];

/**
 * The stable codes the privacy policy's errors carry, so a client can tell them
 * apart (#934). An object of string literals rather than an enum, as
 * `MailFailureCode` is: `CodedHttpException` takes an upper-case string, and an
 * enum member is not one to the compiler.
 */
export const PrivacyPolicyErrorCode = {
  LanguageTagNotFound: 'PRIVACY_POLICY_LANGUAGE_TAG_NOT_FOUND',
  NotFound: 'PRIVACY_POLICY_NOT_FOUND',
  Empty: 'PRIVACY_POLICY_EMPTY',
  TooLong: 'PRIVACY_POLICY_TOO_LONG',
} as const;

export type PrivacyPolicyErrorCode = (typeof PrivacyPolicyErrorCode)[keyof typeof PrivacyPolicyErrorCode];
