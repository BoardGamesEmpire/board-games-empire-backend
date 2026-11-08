import { Prisma } from '@bge/database';

/**
 * What `GET /system-settings` and `PATCH /system-settings/:id` return (#572).
 *
 * Both routes used to return the row as stored, `mediaSigningSecret` included,
 * to every holder of `read` on `SystemSetting`. That is the Owner, and Admin
 * and Moderator through their staff `read` on `all`. A `select` makes a new
 * column invisible until someone names it here, and `read-shapes.spec.ts`
 * fails until each column is either named here or withheld below, with the
 * reason. Prisma's `omit` on the withheld columns would be shorter, but
 * it is a denylist: a column added later, a secret included, would ship by
 * default.
 *
 * `id` is published because the PATCH addresses the row by it.
 */
export const SYSTEM_SETTINGS_SELECT = {
  id: true,
  name: true,

  allowPasswordResets: true,
  allowUserRegistration: true,
  allowUsernameChange: true,
  providerLinkingPolicy: true,

  feedbackReportRetentionDays: true,
  feedbackReportServerRedactionEnabled: true,

  requireContributionApproval: true,
  contributionReclaimDays: true,

  auditLogRetentionDays: true,
  reviewGatewayLanguages: true,
  reviewGatewayPlatforms: true,
  reviewGatewayCategories: true,
  reviewGatewayMechanics: true,

  householdInviteePolicy: true,
  eventInviteePolicy: true,

  smtpHost: true,
  smtpPort: true,
  smtpSecurity: true,
  smtpUser: true,
  mailFromAddress: true,
  passwordResetLinkLifetimeMinutes: true,
} as const satisfies Prisma.SystemSettingSelect;

/**
 * `SystemSetting` scalars deliberately withheld from both routes, and why.
 */
export const SYSTEM_SETTINGS_SCALARS_OMITTED = {
  mediaSigningSecret:
    'The media URL signing key, encrypted at rest. Only `SigningKeyService` decrypts it, server-side, and no client has a use for even the ciphertext.',
  smtpPassword:
    'The SMTP password, encrypted at rest. Only the worker decrypts it to send mail; a read says only whether one is set, as `smtpPasswordSet`.',
  identifier:
    'The server identity, minted once by the seed. Clients read it as `bgeServerId` from `/.well-known/bge-identity`; it is not a setting, and no route changes it.',
  singleton: 'Row bookkeeping: the unique flag that keeps the table to one row.',
} as const satisfies Partial<Record<Prisma.SystemSettingScalarFieldEnum, string>>;

/**
 * What the service selects: the published columns plus the SMTP password's
 * ciphertext, which `toView` reduces to `smtpPasswordSet` before anything
 * leaves the service (#654).
 */
export const SYSTEM_SETTINGS_ROW_SELECT = {
  ...SYSTEM_SETTINGS_SELECT,
  smtpPassword: true,
} as const satisfies Prisma.SystemSettingSelect;

export type SystemSettingsRow = Prisma.SystemSettingGetPayload<{ select: typeof SYSTEM_SETTINGS_ROW_SELECT }>;

export type SystemSettingsView = Prisma.SystemSettingGetPayload<{ select: typeof SYSTEM_SETTINGS_SELECT }> & {
  /** Whether an SMTP password is stored. The password itself is never returned. */
  smtpPasswordSet: boolean;
};

/** Drops the SMTP password and its ciphertext, keeping only whether one is set. */
export function toView({ smtpPassword, ...published }: SystemSettingsRow): SystemSettingsView {
  return { ...published, smtpPasswordSet: smtpPassword !== null };
}
