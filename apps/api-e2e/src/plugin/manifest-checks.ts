import type { PluginManifest } from '@boardgamesempire/plugin-manifest';

/**
 * The manifest permission checks shared by the plugin specs that arrange a
 * plugin and then make real requests against it: the household, user and
 * server consent acts, the consent race, and the household routes that meet a
 * missing or deleted household. The inventory specs use the `Check` type.
 *
 * Separate from `lock-fixtures.ts` deliberately. That module serves the specs
 * that speak to Postgres directly and says so, and its plugin row carries a
 * placeholder manifest nothing reads or validates. These specs go through
 * manifest revalidation, so theirs has to be real — the two fixtures share a
 * name and almost nothing else.
 *
 * Only what is genuinely identical lives here. The household and user checks
 * stay local to their specs, and that is the point rather than an oversight:
 * `read:game:public` is REQUIRED where a household switch-on must answer it
 * (the consent acts and the consent race), and OPTIONAL where a household
 * toggles it (the specs about a missing or deleted household, and the race's
 * own optional copy), since a toggle answers only an optional permission.
 * A shared constant would have to pick one, and whichever it picked would
 * quietly change what the other specs prove.
 */
export type Check = PluginManifest['permissions']['checks'][number];

/**
 * A required server-scope check on the plugin's own `manage:digest`.
 *
 * It is there so the arranged plugin carries a permission row and a required
 * server check at all. Every spec that imports it wants it to the character.
 */
export const MANAGE_DIGEST_CHECK: Check = {
  slug: 'manage:digest',
  required: true,
  reason: { en: 'Stores and manages the digest configuration it owns.' },
  consentScope: 'server',
};
