import { PERMISSION_CATALOG } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { I18nMessage } from '@bge/i18n';

/** The slugs the `permissions` catalog describes, one entry each, as the completeness spec pins (#1417). */
const DESCRIBED_SLUGS: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map(({ slug }) => slug));

/**
 * The plain-language description of a core permission, as a deferred
 * translation the edge renders in the request's language (#1417). A screen
 * reader announces it on the client's key creation screen, so it is the
 * `permissions` catalog's text and never the permission's `reason`, which is the
 * Owner's editable note about the row and isn't localized.
 *
 * The grantable route passes every slug its owner's graph holds, not only the
 * catalog's: a permission an Owner edited stays live after a later catalog
 * stops shipping it. Such a slug has no entry, and its key would reach the
 * screen reader as the description, so it gets a generic sentence instead. The
 * completeness spec in `permission-description.spec.ts` fails the build when a
 * catalog permission has no entry, or an entry names a permission the catalog
 * lacks, so every catalog slug keeps its own text (#1417).
 */
export function permissionDescription(slug: string): I18nMessage {
  if (!DESCRIBED_SLUGS.has(slug)) {
    return new I18nMessage('common.permission_without_description');
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the `permissions` catalog holds this key for every catalog slug, which the completeness spec pins (#1417, #1321)
  return new I18nMessage(`permissions.${slug}` as I18nPath);
}
