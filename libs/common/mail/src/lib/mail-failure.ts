import type { I18nPath } from '@bge/i18n-core';

/**
 * Stable codes for why an outgoing mail did not go (#654). They carry no
 * detail from the SMTP server, so a code is safe to store and to show.
 */
export const MailFailureCode = {
  NotConfigured: 'MAIL_NOT_CONFIGURED',
  SettingsUnreadable: 'MAIL_SETTINGS_UNREADABLE',
  AuthFailed: 'MAIL_AUTH_FAILED',
  HostUnreachable: 'MAIL_HOST_UNREACHABLE',
  TlsFailed: 'MAIL_TLS_FAILED',
  Rejected: 'MAIL_REJECTED',
  SendFailed: 'MAIL_SEND_FAILED',
} as const;

export type MailFailureCode = (typeof MailFailureCode)[keyof typeof MailFailureCode];

const NODEMAILER_CODES: ReadonlyMap<string, MailFailureCode> = new Map([
  ['EAUTH', MailFailureCode.AuthFailed],
  ['ENOAUTH', MailFailureCode.AuthFailed],
  ['ECONNECTION', MailFailureCode.HostUnreachable],
  ['ETIMEDOUT', MailFailureCode.HostUnreachable],
  ['EDNS', MailFailureCode.HostUnreachable],
  ['ESOCKET', MailFailureCode.HostUnreachable],
  ['ETLS', MailFailureCode.TlsFailed],
  ['EENVELOPE', MailFailureCode.Rejected],
  // The server refused the message after DATA.
  ['EMESSAGE', MailFailureCode.Rejected],
]);

/**
 * Under an implicit-TLS connection nodemailer reports a certificate failure as
 * `ESOCKET` and keeps the TLS error's own code in `originalCode`. Node's
 * certificate-verification codes come from OpenSSL and carry no shared prefix,
 * so these are listed; `ERR_TLS_*` and `ERR_SSL_*` are matched by prefix.
 */
const TLS_CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'HOSTNAME_MISMATCH',
]);

function isTlsCode(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    (TLS_CERTIFICATE_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))
  );
}

/** Maps a nodemailer error to a stable code. Anything unrecognised is a send failure. */
export function classifyMailError(error: unknown): MailFailureCode {
  if (typeof error !== 'object' || error === null) {
    return MailFailureCode.SendFailed;
  }

  const { code, originalCode } = error as { code?: unknown; originalCode?: unknown };

  if (typeof code !== 'string') {
    return MailFailureCode.SendFailed;
  }

  if (code === 'ESOCKET' && isTlsCode(originalCode)) {
    return MailFailureCode.TlsFailed;
  }

  return NODEMAILER_CODES.get(code) ?? MailFailureCode.SendFailed;
}

const TEST_RESULT_KEYS: Readonly<Record<MailFailureCode, I18nPath>> = {
  [MailFailureCode.NotConfigured]: 'mail.test_result.not_configured',
  [MailFailureCode.SettingsUnreadable]: 'mail.test_result.settings_unreadable',
  [MailFailureCode.AuthFailed]: 'mail.test_result.auth_failed',
  [MailFailureCode.HostUnreachable]: 'mail.test_result.host_unreachable',
  [MailFailureCode.TlsFailed]: 'mail.test_result.tls_failed',
  [MailFailureCode.Rejected]: 'mail.test_result.rejected',
  [MailFailureCode.SendFailed]: 'mail.test_result.send_failed',
};

/** The catalog key of the test email's outcome, for the admin's notification (#654). */
export function mailTestResultMessageKey(code: MailFailureCode | null): I18nPath {
  return code === null ? 'mail.test_result.sent' : TEST_RESULT_KEYS[code];
}
