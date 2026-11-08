import { SmtpSecurity } from '@bge/database';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { MailSettings } from './mail-settings';

/**
 * Nodemailer's defaults wait two minutes for a connection, so an admin's test
 * email could hang that long. These keep the answer under a minute (#654).
 */
const CONNECTION_TIMEOUT_MS = 30_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

const SECURITY_OPTIONS: Record<SmtpSecurity, Pick<SMTPTransport.Options, 'secure' | 'requireTLS' | 'ignoreTLS'>> = {
  [SmtpSecurity.StartTls]: { secure: false, requireTLS: true },
  [SmtpSecurity.ImplicitTls]: { secure: true },
  [SmtpSecurity.None]: { secure: false, ignoreTLS: true },
};

/**
 * Builds nodemailer's transport options from the settings row. `password` is
 * the decrypted SMTP password: the row's own column holds ciphertext and never
 * reaches nodemailer (#654). Nothing here logs or returns the password.
 */
export function smtpTransportOptions(settings: MailSettings, password: string | null): SMTPTransport.Options {
  return {
    host: settings.smtpHost ?? undefined,
    port: settings.smtpPort ?? undefined,
    ...SECURITY_OPTIONS[settings.smtpSecurity],
    ...(settings.smtpUser ? { auth: { user: settings.smtpUser, pass: password ?? '' } } : {}),
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };
}

/** The sender of every outgoing mail: the server's name at the configured From address. */
export function mailFrom(settings: MailSettings): { name: string; address: string } {
  return { name: settings.name, address: settings.mailFromAddress ?? '' };
}
