import { PERMISSION_CATALOG } from '@bge/database';
import { I18N_CATALOG_DIR, isI18nMessage } from '@bge/i18n';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { permissionDescription } from './permission-description';

/**
 * The English `permissions` catalog, read from the directory the server loads
 * its catalogs from, so the spec checks what ships (#1417).
 */
function shippedDescriptions(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(I18N_CATALOG_DIR, 'en', 'permissions.json'), 'utf8'));
}

describe('permission descriptions (#1417)', () => {
  it('gives every catalog permission a description, so a gap fails the build', () => {
    const descriptions = shippedDescriptions();
    const missing = PERMISSION_CATALOG.map(({ slug }) => slug).filter((slug) => {
      const text = descriptions[slug];

      return typeof text !== 'string' || text.trim() === '';
    });

    expect(missing).toEqual([]);
  });

  it('describes no permission the catalog lacks', () => {
    const slugs = new Set<string>(PERMISSION_CATALOG.map(({ slug }) => slug));
    const orphans = Object.keys(shippedDescriptions()).filter((key) => !slugs.has(key));

    expect(orphans).toEqual([]);
  });

  it('writes each description as one plain sentence a screen reader can announce', () => {
    const offenders = Object.entries(shippedDescriptions()).filter(([, text]) => {
      return typeof text !== 'string' || !/^[A-Z][^.]*\.$/.test(text) || /[:_{}<>`]/.test(text);
    });

    expect(offenders).toEqual([]);
  });

  it('names the permissions namespace', () => {
    const message = permissionDescription('read:game');

    expect(isI18nMessage(message)).toBe(true);
    expect(message.key).toBe('permissions.read:game');
  });

  // A permission an Owner edited stays live after a later catalog stops
  // shipping it; its i18n key must not reach a screen reader as text.
  it('gives a slug the catalog does not describe a generic sentence, not its key', () => {
    const message = permissionDescription('read:retired_thing');

    expect(message.key).toBe('common.permission_without_description');
  });
});
