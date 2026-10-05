import { Prisma } from '@bge/database';

/**
 * What `GET /system-settings` and `PATCH /system-settings/:id` return (#572).
 *
 * Both routes used to return the row as stored, `mediaSigningSecret` included,
 * to every holder of `read` on `SystemSetting`. That is the Owner, and Admin
 * and Moderator through their staff `read` on `all`. A `select` makes a new
 * column invisible until someone names it here, and `read-shapes.spec.ts`
 * fails until each column is either named here or withheld below, with the
 * reason. Prisma's `omit` on the three withheld columns would be shorter, but
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

  feedbackReportRetentionDays: true,
  feedbackReportServerRedactionEnabled: true,

  requireContributionApproval: true,
  contributionReclaimDays: true,

  auditLogRetentionDays: true,
  reviewGatewayLanguages: true,
} as const satisfies Prisma.SystemSettingSelect;

/**
 * `SystemSetting` scalars deliberately withheld from both routes, and why.
 */
export const SYSTEM_SETTINGS_SCALARS_OMITTED = {
  mediaSigningSecret:
    'The media URL signing key, encrypted at rest. Only `SigningKeyService` decrypts it, server-side, and no client has a use for even the ciphertext.',
  identifier:
    'The server identity, minted once by the seed. Clients read it as `bgeServerId` from `/.well-known/bge-identity`; it is not a setting, and no route changes it.',
  singleton: 'Row bookkeeping: the unique flag that keeps the table to one row.',
} as const satisfies Partial<Record<Prisma.SystemSettingScalarFieldEnum, string>>;

export type SystemSettingsView = Prisma.SystemSettingGetPayload<{ select: typeof SYSTEM_SETTINGS_SELECT }>;
