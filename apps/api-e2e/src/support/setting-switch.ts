import type { SystemSetting } from '@bge/database';
import type { TestDatabase } from './test-db';

/** The settings row's switches that better-auth's routes obey (#585). */
export type SettingSwitch = keyof Pick<
  SystemSetting,
  'allowUserRegistration' | 'allowPasswordResets' | 'allowUsernameChange'
>;

/**
 * Turns one of the settings row's switches on before each test in the calling
 * `describe`, and puts back what it held after. The row is on the isolation
 * sweep's preserved list, so a switch left changed would carry into every
 * spec after.
 *
 * Returns the setter a test flips the switch with. `database` is called at
 * each hook rather than now, since a spec opens its database in `beforeAll`.
 */
export function useSettingSwitch(database: () => TestDatabase, name: SettingSwitch): (on: boolean) => Promise<void> {
  const set = async (on: boolean): Promise<void> => {
    const data: Partial<Record<SettingSwitch, boolean>> = { [name]: on };
    await database().client.systemSetting.update({ where: { singleton: true }, data });
  };

  let original: boolean;

  beforeEach(async () => {
    original = (await database().client.systemSetting.findUniqueOrThrow({ where: { singleton: true } }))[name];
    await set(true);
  });

  afterEach(async () => {
    await set(original);
  });

  return set;
}
