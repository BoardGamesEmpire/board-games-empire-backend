import type { Prisma, SystemSetting } from '@bge/database';

/**
 * The columns `isMailConfigured` reads (#654). Every reader that asks whether
 * mail is set up selects these, so a column added to the check reaches all of
 * them: discovery, the reset gate, the test email and the worker.
 */
export const MAIL_READINESS_SELECT = {
  smtpHost: true,
  mailFromAddress: true,
} as const satisfies Prisma.SystemSettingSelect;

/**
 * The columns of the settings row that outgoing mail reads (#654). The
 * password is the stored ciphertext; callers decrypt it and pass the plain
 * text to `smtpTransportOptions`.
 */
export const MAIL_SETTINGS_SELECT = {
  ...MAIL_READINESS_SELECT,
  name: true,
  smtpPort: true,
  smtpSecurity: true,
  smtpUser: true,
  smtpPassword: true,
} as const satisfies Prisma.SystemSettingSelect;

export type MailSettings = Prisma.SystemSettingGetPayload<{ select: typeof MAIL_SETTINGS_SELECT }>;

/**
 * Outgoing mail is set up when the row names an SMTP host and a From address.
 * Blank counts as unset, so a form that saves whitespace never enables it.
 */
export function isMailConfigured(row: Pick<SystemSetting, keyof typeof MAIL_READINESS_SELECT> | null): boolean {
  return Boolean(row?.smtpHost?.trim()) && Boolean(row?.mailFromAddress?.trim());
}
