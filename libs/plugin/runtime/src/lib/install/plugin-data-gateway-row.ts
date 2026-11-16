import { constraintIdentity, identifiesConstraint, type Prisma } from '@bge/database';
import { resolveLocalizedString, type PluginManifest } from '@boardgamesempire/plugin-manifest';

/**
 * A data-gateway plugin's DataGateway row (#1083): what installing,
 * uninstalling and reinstalling the plugin do to it. Everything in the plugin
 * runtime that knows what a DataGateway row is lives here; the installer only
 * asks whether a plugin is a data-gateway plugin.
 *
 * The row is a plugin DataGateway: it names its plugin and none of the
 * connection fields a remote DataGateway sets. Installing creates it, enabled.
 * Uninstalling disables it and keeps it, because the game sources imported
 * through it hang on it. Reinstalling, which keeps the plugin's id, enables it
 * again.
 *
 * An update touches none of this unless it moves the plugin into or out of
 * the data-gateway category. Then the row follows: placed on the way in, as
 * an install places it, and disabled and kept on the way out, as an uninstall
 * leaves it.
 */

/**
 * The unique index on `DataGateway.name`, in every spelling `constraintIdentity`
 * reports it: the index name the driver adapter reports since
 * `@prisma/adapter-pg@7.10`, and the column (which the Prisma field shares)
 * it reported before.
 */
const DATA_GATEWAY_NAME_UNIQUE_INDEX = 'data_gateways_name_key';
const DATA_GATEWAY_NAME_UNIQUE_COLUMNS = ['name'] as const;

export interface PluginDataGatewayPlacement {
  readonly pluginId: string;
  /** The name a new row takes; a row the plugin kept keeps its own. */
  readonly name: string;
  readonly installerId: string;

  /**
   * The refusal to throw when the new row's name is taken. The caller's own,
   * since what the server admin does next differs: install again, or try the
   * update again.
   */
  readonly nameTaken: (name: string) => Error;
}

/**
 * The name a data-gateway plugin's DataGateway row takes: its display name in
 * the server default locale. Resolved rather than indexed, so a bare string
 * display name, or a map keyed `en-us` for a default of `en-US`, names the row
 * the way the manifest validator accepted it.
 */
export function pluginDataGatewayName(manifest: PluginManifest, defaultLocale: string): string {
  return resolveLocalizedString(manifest.displayName, { locale: defaultLocale, defaultLocale });
}

/**
 * The row holding `name` when installing the plugin would create a row under
 * it, else null. `pluginId` is the plugin's existing row's id, null when it
 * has never been installed.
 *
 * A plugin that already has its DataGateway row creates none, so it has no
 * conflict whatever names are taken: an admin may have renamed the kept row,
 * and another row taken the manifest's name since, and the reinstall still
 * never meets that name.
 */
export async function findDataGatewayNameHolder(
  db: Pick<Prisma.TransactionClient, 'dataGateway'>,
  name: string,
  pluginId: string | null,
): Promise<{ id: string } | null> {
  if (pluginId !== null && (await keptRow(db, pluginId)) !== null) {
    return null;
  }

  return nameHolder(db, name);
}

/**
 * Creates the plugin's row, or enables the one it already has. Throws the
 * caller's `nameTaken` refusal when a new row's name is taken.
 *
 * A reinstalled plugin keeps its id and its row, so the row is enabled and
 * nothing else on it moves: a name an admin gave it, its interview answers and
 * the game sources that hang on it all stay. The same holds for a plugin an
 * update moves back into the data-gateway category.
 */
export async function placePluginDataGatewayRow(
  tx: Prisma.TransactionClient,
  input: PluginDataGatewayPlacement,
): Promise<void> {
  const kept = await tx.dataGateway.updateMany({ where: { pluginId: input.pluginId }, data: { enabled: true } });

  if (kept.count > 0) {
    return;
  }

  // The read is for the readable refusal. A row created between it and the
  // insert is caught by the unique index on the name, refused the same way.
  if ((await nameHolder(tx, input.name)) !== null) {
    throw input.nameTaken(input.name);
  }

  try {
    await tx.dataGateway.create({
      data: { name: input.name, pluginId: input.pluginId, enabled: true, createdById: input.installerId },
    });
  } catch (error) {
    if (isNameCollision(error)) {
      throw input.nameTaken(input.name);
    }

    throw error;
  }
}

/**
 * Disables the plugin's row and keeps it: for an uninstall, and for an update
 * that moves the plugin out of the data-gateway category. Routing refuses a
 * disabled row from the database, so nothing is published for it. A plugin
 * that never was a data-gateway plugin has no row, and this matches none.
 */
export async function disablePluginDataGatewayRow(tx: Prisma.TransactionClient, pluginId: string): Promise<void> {
  await tx.dataGateway.updateMany({ where: { pluginId }, data: { enabled: false } });
}

function keptRow(db: Pick<Prisma.TransactionClient, 'dataGateway'>, pluginId: string): Promise<{ id: string } | null> {
  return db.dataGateway.findUnique({ where: { pluginId }, select: { id: true } });
}

/** Any row holding the name. A deleted DataGateway keeps its name (#754), so deleted rows count. */
function nameHolder(db: Pick<Prisma.TransactionClient, 'dataGateway'>, name: string): Promise<{ id: string } | null> {
  return db.dataGateway.findUnique({ where: { name }, select: { id: true } });
}

/**
 * True when a failed insert broke the unique name. A violation on the plugin
 * id, or one that cannot be told apart, is not a name conflict, and passes
 * through as it is: a refusal naming the wrong cause would send the server
 * admin to rename a row that is not in the way.
 */
function isNameCollision(error: unknown): boolean {
  return identifiesConstraint(
    constraintIdentity(error),
    [DATA_GATEWAY_NAME_UNIQUE_INDEX],
    DATA_GATEWAY_NAME_UNIQUE_COLUMNS,
  );
}
