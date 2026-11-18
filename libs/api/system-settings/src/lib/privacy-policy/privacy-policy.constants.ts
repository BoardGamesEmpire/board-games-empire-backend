/**
 * The most characters a privacy policy's Markdown may have, before it is
 * sanitized: a policy file's body and a server admin's replacement alike
 * (#934). The sanitizer keeps longer Markdown as plain text with its markup
 * shown, which would flatten the headings and lists a screen reader moves by.
 */
export const PRIVACY_POLICY_MAX_LENGTH = 20_000;

/** The stable codes the privacy policy's errors carry, so a client can tell them apart (#934). */
export enum PrivacyPolicyErrorCode {
  LanguageTagNotFound = 'PRIVACY_POLICY_LANGUAGE_TAG_NOT_FOUND',
  NotFound = 'PRIVACY_POLICY_NOT_FOUND',
  Empty = 'PRIVACY_POLICY_EMPTY',
}
