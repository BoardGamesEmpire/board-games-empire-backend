import type { PluginManifest } from '@boardgamesempire/plugin-manifest';

/**
 * The manifest permission checks shared by the #360 consent specs — the two
 * that arrange a plugin and then make real requests against it.
 *
 * Separate from `lock-fixtures.ts` deliberately. That module serves the specs
 * that speak to Postgres directly and says so, and its plugin row carries a
 * placeholder manifest nothing reads or validates. These specs go through
 * manifest revalidation, so theirs has to be real — the two fixtures share a
 * name and almost nothing else.
 *
 * Only what is genuinely identical lives here. The household and user checks
 * stay local to their specs, and that is the point rather than an oversight:
 * `read:household_member` is REQUIRED in the consent race, where denying it
 * must suspend the unit, and OPTIONAL in the pre-row race, where a required one
 * would make the enable born-suspended and that case is about waiting. A shared
 * constant would have to pick one, and whichever it picked would quietly change
 * what the other spec proves.
 */
export type Check = PluginManifest['permissions']['checks'][number];

/**
 * A required server-scope check that neither spec decides on.
 *
 * It is there so the arranged plugin carries a permission row and a required
 * server check at all. Both specs had it to the character; nothing about either
 * one wants it to differ.
 */
export const MANAGE_DIGEST_CHECK: Check = {
  slug: 'manage:digest',
  required: true,
  reason: { en: 'Stores and manages the digest configuration it owns.' },
  consentScope: 'server',
};
