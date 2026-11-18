import type { Plugin } from '@bge/database';
import { DatabaseService } from '@bge/database';
import {
  PluginDirectoryNotFoundError,
  PluginDirectoryResolverService,
  PluginGrantAuthorityService,
  PluginUpdateAuthorityError,
  PluginUpdateForbiddenPermissionError,
  PluginUpdateManifestError,
  PluginUpdatePluginNotFoundError,
  PluginUpdateService,
  PluginUpdateTombstonedError,
  PluginUpdateUnknownCorePermissionError,
} from '@bge/plugin';
import type { PluginArtifactDirectory, PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { Injectable, Logger } from '@nestjs/common';
import { PluginArtifactBelongsToAnotherPluginError, PluginArtifactNotFoundError } from '../artifacts.errors';
import { parseRequestedSha256 } from '../receive/requested-sha256';
import { PluginArtifactStore } from '../store/plugin-artifact.store';
import { removeArtifactRowBestEffort } from '../store/remove-artifact-row';

export interface StagePluginArtifactInput {
  /** Exact re-entry of every forbidden import static analysis reported on the new version. */
  readonly acknowledgeForbiddenImports?: readonly string[];

  readonly actorId: string;

  /** Extend static analysis into node_modules; its findings only advise. */
  readonly deepScan?: boolean;

  /** The checksum of a received plugin artifact, as its receipt names it, in either case. */
  readonly sha256: string;

  /** The plugin the update is for. */
  readonly slug: string;
}

export interface PluginArtifactStagingResult {
  /** True when the plugin now runs this checksum; false when the update waits for approval. */
  readonly activated: boolean;

  /**
   * The DataGateway name the staged update's move into data-gateway would
   * take, when another row holds it (#1096, #1083); null once activated.
   */
  readonly dataGatewayNameConflict: string | null;

  readonly plugin: Plugin;
}

/**
 * Stages an update of an installed plugin from a received plugin artifact,
 * named by its checksum (#1096), as `PluginArtifactInstaller` installs one.
 * The artifact's row supplies its link and registry, which the staged update
 * records as provenance. Once the update is staged the plugin's row names the
 * artifact's directory, so the artifact's row has done its job and is
 * deleted.
 *
 * A staging that is already done, as after a double click or a retry after a
 * lost response, answers with the current record and does nothing else: the
 * staged update when the plugin already has one from this checksum, the
 * plugin when it already runs it (ADR-0002). Two stagings at once both find
 * nothing done and both go on; the one that loses answers the same way, from
 * a fresh read of the plugin's row, whether it loses at the staging or finds
 * the artifact's row already deleted.
 *
 * Nothing here opens a transaction or writes the plugin's row: the staging's
 * writes are `PluginUpdateService.stage`'s, and the only other write is the
 * artifact row's deletion.
 */
@Injectable()
export class PluginArtifactStager {
  private readonly logger = new Logger(PluginArtifactStager.name);

  constructor(
    private readonly store: PluginArtifactStore,
    private readonly updates: PluginUpdateService,
    private readonly directories: PluginDirectoryResolverService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly db: DatabaseService,
  ) {}

  async stage(input: StagePluginArtifactInput): Promise<PluginArtifactStagingResult> {
    // Before anything is read: refreshing the artifact's row moves its
    // expiry, which only a server admin may do. The staging checks again.
    if (!(await this.authority.isServerAdmin(input.actorId))) {
      throw new PluginUpdateAuthorityError(input.actorId);
    }

    const sha256 = parseRequestedSha256(input.sha256);
    if (sha256 === null) {
      throw new PluginArtifactNotFoundError(input.sha256);
    }

    const plugin = await this.db.plugin.findUnique({ where: { slug: input.slug } });
    if (plugin === null) {
      throw new PluginUpdatePluginNotFoundError(input.slug);
    }

    if (plugin.uninstalledAt !== null) {
      throw new PluginUpdateTombstonedError(plugin.slug, plugin.uninstalledAt);
    }

    // The first staging deleted the artifact's row, so a repeat would answer
    // not found: look at what the plugin already has first.
    const done = await this.alreadyDone(plugin, sha256);
    if (done !== null) {
      return done;
    }

    // The refresh moves the expiry forward as it reads the row, so a sweep
    // running during the staging keeps the artifact's directory. An expired
    // row reads as absent.
    const artifact = await this.store.refreshForInstall(sha256, new Date());
    if (artifact === null) {
      // A concurrent staging of the same checksum may have committed and
      // deleted the row since the read above: the staging is done all the
      // same.
      const winner = await this.winner(input.slug, sha256);
      if (winner !== null) {
        return winner;
      }

      throw new PluginArtifactNotFoundError(sha256);
    }

    if (artifact.slug !== plugin.slug) {
      // The row stays: it may yet install or update the plugin it is for.
      throw new PluginArtifactBelongsToAnotherPluginError(plugin.slug, artifact.slug, sha256);
    }

    let directory: PluginArtifactDirectory;
    try {
      directory = await this.directories.resolve(artifact.slug, sha256);
    } catch (err) {
      if (err instanceof PluginDirectoryNotFoundError) {
        // A row without its directory can never be staged: drop it.
        await removeArtifactRowBestEffort(this.store, this.logger, sha256, "The plugin artifact's directory is gone");
        throw new PluginArtifactNotFoundError(sha256);
      }

      throw err;
    }

    let staged: PluginArtifactStagingResult;
    try {
      const result = await this.updates.stage({
        directory,
        url: artifact.url ?? undefined,
        registrySlug: artifact.registrySlug ?? undefined,
        initiatorId: input.actorId,
        acknowledgeForbiddenImports: input.acknowledgeForbiddenImports,
        deepScan: input.deepScan,
      });

      staged = {
        plugin: result.plugin,
        activated: result.activated,
        dataGatewayNameConflict: result.dataGatewayNameConflict,
      };
    } catch (err) {
      // A concurrent staging of the same checksum, as from a double click,
      // committed first, so this one was refused: the staging is done all the
      // same. While the plugin neither has this checksum staged nor runs it,
      // the refusal is the answer, whatever it was, and the artifact's row
      // stays so the server admin can try again. A look for a winner that
      // fails leaves the refusal as the answer, and a warning as its trace.
      const winner = await this.winner(input.slug, sha256).catch((readErr: unknown) => {
        this.logger.warn(
          `Staging an update of plugin '${input.slug}' was refused, and the look for a staging that won failed: ${
            readErr instanceof Error ? readErr.message : String(readErr)
          }`,
        );

        return null;
      });
      if (winner === null) {
        throw err;
      }

      return winner;
    }

    // The staged update names the directory from here, whatever happens next.
    await removeArtifactRowBestEffort(
      this.store,
      this.logger,
      sha256,
      staged.activated ? `Plugin '${plugin.slug}' now runs this artifact` : `Plugin '${plugin.slug}' has it staged`,
    );

    return staged;
  }

  /**
   * The answer for a staging of this checksum that is already done, from the
   * plugin's row: its staged update, when that is from this checksum, or the
   * plugin, when it runs it. Null when neither holds. The artifact step's
   * assessment reports these two artifacts as `active_version` and
   * `staged_update_waiting`, which for any other artifact are refusals (#1096).
   */
  private async alreadyDone(plugin: Plugin, sha256: PluginArtifactSha256): Promise<PluginArtifactStagingResult | null> {
    if (plugin.pendingSha256 === sha256) {
      return { plugin, activated: false, dataGatewayNameConflict: await this.stagedNameConflict(plugin) };
    }

    if (plugin.installedSha256 === sha256) {
      return { plugin, activated: true, dataGatewayNameConflict: null };
    }

    return null;
  }

  /** The same questions, asked of a fresh read of the plugin's row after a staging that may have lost a race. */
  private async winner(slug: string, sha256: PluginArtifactSha256): Promise<PluginArtifactStagingResult | null> {
    const plugin = await this.db.plugin.findUnique({ where: { slug } });

    if (plugin === null || plugin.uninstalledAt !== null) {
      return null;
    }

    return this.alreadyDone(plugin, sha256);
  }

  /**
   * The taken DataGateway name of the staged update in this row, as the
   * staged-update read works it out now. It describes the row already read,
   * never a fresh one, so a staging rejected or replaced since cannot turn a
   * repeat into a refusal or answer with a name for another staging (#1096).
   * When the read refuses over the stored manifests (one cannot be read, or a
   * permission it requests is a core permission retired since the staging or
   * is forbidden), it reports none: the staging is done, and must still
   * answer. Any other failure, a database one included, propagates rather
   * than reading as no conflict.
   */
  private async stagedNameConflict(plugin: Plugin): Promise<string | null> {
    try {
      return (await this.updates.describeStaging(plugin)).dataGatewayNameConflict;
    } catch (err) {
      if (
        err instanceof PluginUpdateManifestError ||
        err instanceof PluginUpdateUnknownCorePermissionError ||
        err instanceof PluginUpdateForbiddenPermissionError
      ) {
        return null;
      }

      throw err;
    }
  }
}
