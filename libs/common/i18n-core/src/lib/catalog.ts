import * as path from 'node:path';

/**
 * Directory holding the translation catalogs, `<locale>/*.json`. The one place
 * runtime code resolves the catalog location, so the nestjs-i18n loader and the
 * specs that load the real catalogs cannot drift apart.
 *
 * Resolved from `__dirname`, which is this source directory under jest (swc,
 * unbundled) and the app's `dist` directory in a webpack bundle — where each
 * in-scope app (api, worker, gateway-worker) copies `./i18n` in as an asset
 * (#139).
 */
export const I18N_CATALOG_DIR = path.join(__dirname, 'i18n');
