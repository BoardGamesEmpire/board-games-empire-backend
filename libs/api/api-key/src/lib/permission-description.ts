import type { I18nPath } from '@bge/i18n';
import { I18nMessage } from '@bge/i18n';

/**
 * The plain-language description of a core permission, as a deferred
 * translation the edge renders in the request's language (#1417). A screen
 * reader announces it on the client's key creation screen, so it is the
 * `permissions` catalog's text and never the permission's `reason`, which is the
 * Owner's editable note about the row and isn't localized.
 *
 * The key is built from the slug. The grantable route passes every slug its
 * owner's graph holds, not only the catalog's: a permission an Owner edited
 * stays live after a later catalog stops shipping it, and such a slug has no
 * entry, so its description renders as its i18n key. The completeness spec in
 * `permission-description.spec.ts` fails the build when a catalog permission
 * has no entry, or an entry names a permission the catalog lacks; it can't see
 * a slug outside the catalog. There is no fallback text: a missing
 * description is a catalog gap to fix, not something to hide (#1417).
 */
export function permissionDescription(slug: string): I18nMessage {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the `permissions` catalog holds this key for every catalog slug, which the completeness spec pins; a slug outside the catalog, from a permission an Owner edited that a later catalog no longer ships, renders as its key (#1417, #1321)
  return new I18nMessage(`permissions.${slug}` as I18nPath);
}
