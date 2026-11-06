import { DatabaseService, type Plugin } from '@bge/database';
import {
  PluginDirectoryNotFoundError,
  PluginDirectoryResolverService,
  PluginGrantAuthorityService,
  PluginInstallAuthorityError,
  PluginInstallerService,
  type PluginInstallResult,
} from '@bge/plugin';
import type { PluginArtifactDirectory, PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { Injectable, Logger } from '@nestjs/common';
import { PluginArtifactNotFoundError } from '../artifacts.errors';
import { parseRequestedSha256 } from '../receive/requested-sha256';
import { PluginArtifactStore } from '../store/plugin-artifact.store';

export interface InstallPluginArtifactInput {
  /** The checksum of a received plugin artifact, as its receipt names it, in either case. */
  readonly sha256: string;
  readonly actorId: string;
  /** Exact re-entry of every Critical permission slug the install will grant. */
  readonly confirmCriticalSlugs?: readonly string[];
  /** Exact re-entry of every forbidden import static analysis reported. */
  readonly acknowledgeForbiddenImports?: readonly string[];
  /** Extend static analysis into node_modules; its findings only advise. */
  readonly deepScan?: boolean;
}

/**
 * The installed plugin's row. A first install answers the runtime's whole
 * result; an install that was already done answers the row alone, because
 * nothing ran (#1094).
 */
export type PluginArtifactInstallResult = Pick<PluginInstallResult, 'plugin'>;

/**
 * Installs a received plugin artifact by its checksum (#1094). The artifact's
 * row supplies its slug and its link or registry, which the install records
 * as provenance. Once the plugin is installed the row has done its job, and
 * is deleted.
 *
 * An install that is already done, as after a double click or a retry after a
 * lost response, answers with the plugin that runs the checksum, and runs and
 * emits nothing: a state change already at its target answers 2xx with the
 * current record (ADR-0002). Two such installs at once both find nothing
 * installed and both run; the one that loses the race answers the same way,
 * from the plugin the winner installed.
 */
@Injectable()
export class PluginArtifactInstaller {
  private readonly logger = new Logger(PluginArtifactInstaller.name);

  constructor(
    private readonly store: PluginArtifactStore,
    private readonly installer: PluginInstallerService,
    private readonly directories: PluginDirectoryResolverService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly db: DatabaseService,
  ) {}

  async install(input: InstallPluginArtifactInput): Promise<PluginArtifactInstallResult> {
    // Before the row is touched: refreshing it moves its expiry, which only a
    // server admin may do. The runtime install checks again.
    if (!(await this.authority.isServerAdmin(input.actorId))) {
      throw new PluginInstallAuthorityError(input.actorId);
    }

    const sha256 = parseRequestedSha256(input.sha256);
    if (sha256 === null) {
      throw new PluginArtifactNotFoundError(input.sha256);
    }

    // The first install deleted the artifact's row, so a repeat would answer
    // not found: look for the plugin it installed first.
    const installed = await this.installedFrom(sha256);
    if (installed !== null) {
      // A row posted again since has nothing left to install.
      await this.removeRow(sha256, `Plugin '${installed.slug}' is already installed from this artifact`);
      return { plugin: installed };
    }

    // The refresh moves the expiry forward as it reads the row, so a sweep
    // running during the install keeps the artifact's directory. An expired
    // row reads as absent.
    const artifact = await this.store.refreshForInstall(sha256, new Date());
    if (artifact === null) {
      throw new PluginArtifactNotFoundError(sha256);
    }

    let directory: PluginArtifactDirectory;
    try {
      directory = await this.directories.resolve(artifact.slug, sha256);
    } catch (err) {
      if (err instanceof PluginDirectoryNotFoundError) {
        // A row without its directory can never install: drop it.
        await this.removeRow(sha256, "The plugin artifact's directory is gone");
        throw new PluginArtifactNotFoundError(sha256);
      }

      throw err;
    }

    let result: PluginArtifactInstallResult;
    try {
      result = await this.installer.install({
        directory,
        url: artifact.url ?? undefined,
        registrySlug: artifact.registrySlug ?? undefined,
        installerId: input.actorId,
        confirmCriticalSlugs: input.confirmCriticalSlugs,
        acknowledgeForbiddenImports: input.acknowledgeForbiddenImports,
        deepScan: input.deepScan,
      });
    } catch (err) {
      // A concurrent install of the same checksum, as from a double click,
      // committed first, so this one hit its conflict: the install is done
      // all the same. While no plugin runs the checksum, the failure is the
      // answer, whatever it was.
      const winner = await this.installedFrom(sha256).catch(() => null);
      if (winner === null) {
        throw err;
      }

      return { plugin: winner };
    }

    // The plugin is installed whatever happens here.
    await this.removeRow(sha256, `Plugin '${result.plugin.slug}' is installed`);

    return result;
  }

  /** The living plugin that runs this checksum, if any. */
  private installedFrom(sha256: PluginArtifactSha256): Promise<Plugin | null> {
    return this.db.plugin.findFirst({ where: { installedSha256: sha256, uninstalledAt: null } });
  }

  /**
   * Deletes the artifact's row, best effort: the caller's answer does not
   * depend on it, and a row left behind only waits out its expiry.
   */
  private async removeRow(sha256: PluginArtifactSha256, situation: string): Promise<void> {
    await this.store.remove(sha256).catch((err: unknown) => {
      this.logger.warn(
        `${situation}; its artifact row ${sha256} could not be deleted and will wait out its expiry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
}
