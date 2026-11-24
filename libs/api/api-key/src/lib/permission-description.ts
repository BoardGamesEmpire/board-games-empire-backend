import type { I18nPath } from '@bge/i18n';
import { I18nMessage } from '@bge/i18n';

/**
 * The plain-language description of a core permission, as a deferred
 * translation the edge renders in the request's language (#1417). A screen
 * reader announces it on the client's key creation screen, so it is the
 * `permissions` catalog's text and never the permission's `reason`, which is the
 * Owner's editable note about the row and isn't localized.
 *
 * The key is built from the slug, and only core permissions have an entry. The
 * cast is safe because the completeness spec in
 * `permission-description.spec.ts` fails the build when a core permission has no
 * entry, or an entry names a permission the permission catalog lacks. A
 * plugin's declared permission has no description here.
 */
export function permissionDescription(slug: string): I18nMessage {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the slug is built into a key the `permissions` catalog holds for every catalog permission, which the completeness spec pins (#1321)
  return new I18nMessage(`permissions.${slug}` as I18nPath);
}
