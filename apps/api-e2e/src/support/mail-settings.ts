import { SmtpSecurity, type Prisma } from '@bge/database';
import { requireMailpit } from './e2e-env';
import type { TestDatabase } from './test-db';

/** The From address `pointAtMailpit` sets. */
export const MAILPIT_FROM_ADDRESS = 'server@bge.test';

/**
 * The settings row's mail settings, and the reset link's lifetime (#654):
 * every column a mail spec changes, so every one is put back.
 */
const MAIL_COLUMNS = {
  smtpHost: true,
  smtpPort: true,
  smtpSecurity: true,
  smtpUser: true,
  smtpPassword: true,
  mailFromAddress: true,
  passwordResetLinkLifetimeMinutes: true,
} as const satisfies Prisma.SystemSettingSelect;

export interface MailSettingsControl {
  /**
   * Points the mail settings at the harness's Mailpit: its SMTP host and port,
   * no connection security, no user or password, and {@link MAILPIT_FROM_ADDRESS}.
   */
  pointAtMailpit(): Promise<void>;

  /** Writes `data` to the settings row, past the PATCH and its checks. */
  set(data: Prisma.SystemSettingUpdateInput): Promise<void>;
}

/**
 * Gives the calling `describe` control of the mail settings, and puts back
 * what they held after each test, as `useSettingSwitch` does for a switch.
 * The row is on the isolation sweep's preserved list, so a mail setting left
 * changed would carry into every spec after: one left pointing at Mailpit
 * would turn on resets that other specs expect refused.
 *
 * Nothing is changed before a test: the row starts as the seed left it, with
 * no mail settings, and a test calls `pointAtMailpit` when it needs mail.
 * `database` is called at each hook rather than now, since a spec opens its
 * database in `beforeAll`.
 */
export function useMailSettings(database: () => TestDatabase): MailSettingsControl {
  const set = async (data: Prisma.SystemSettingUpdateInput): Promise<void> => {
    await database().client.systemSetting.update({ where: { singleton: true }, data });
  };

  let original: Prisma.SystemSettingGetPayload<{ select: typeof MAIL_COLUMNS }>;

  beforeEach(async () => {
    original = await database().client.systemSetting.findUniqueOrThrow({
      where: { singleton: true },
      select: MAIL_COLUMNS,
    });
  });

  afterEach(async () => {
    await set(original);
  });

  return {
    pointAtMailpit: async () => {
      const { smtpHost, smtpPort } = requireMailpit(process.env);

      await set({
        smtpHost,
        smtpPort,
        smtpSecurity: SmtpSecurity.None,
        smtpUser: null,
        smtpPassword: null,
        mailFromAddress: MAILPIT_FROM_ADDRESS,
      });
    },
    set,
  };
}
