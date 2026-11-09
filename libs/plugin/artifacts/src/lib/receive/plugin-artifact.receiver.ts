import { DatabaseService, type PluginArtifact } from '@bge/database';
import {
  MODULE_OPTIONS_TOKEN,
  PluginDirectoryNotFoundError,
  PluginDirectoryResolverService,
  PluginGrantAuthorityService,
  PluginInstallAuthorityError,
  PluginInstallerService,
  type PluginInstallAssessment,
  type PluginModuleOptions,
} from '@bge/plugin';
import {
  InvalidRequestUrlError,
  OutboundNetworkError,
  RedirectLimitExceededError,
  RedirectToDisallowedTargetError,
  RequestTimeoutError,
  ResponseTooLargeError,
  SecureHttpService,
  SsrfRejectionError,
} from '@bge/secure-http';
import {
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_PACKAGE_JSON_FILENAME,
  type PluginArtifactDirectory,
  type PluginArtifactSha256,
} from '@boardgamesempire/plugin-contract';
import { PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { extractPluginArchive } from '../archive/extract-plugin-archive';
import { readArtifactSlug } from '../archive/read-artifact-slug';
import {
  PluginArtifactChecksumMismatchError,
  PluginArtifactDownloadFailedError,
  PluginArtifactLinkRefusedError,
  PluginArtifactNotFoundError,
  PluginArtifactTooLargeError,
} from '../artifacts.errors';
import { placePluginArtifact } from '../placement/place-plugin-artifact';
import { PluginArtifactStore } from '../store/plugin-artifact.store';
import { allocateIncoming, INCOMING_DIRNAME, type IncomingWorkspace } from '../workspace/incoming';
import { parseRequestedSha256 } from './requested-sha256';

/**
 * One 15-minute limit for the whole download, counted from its start (#1094).
 * It cuts off every hop's connection and the body; the outbound HTTP policy's
 * address lookups count toward it but are bounded by the resolver's own
 * timeouts.
 */
export const PLUGIN_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * What the server knows about a received plugin artifact (#1094): its row,
 * its directory, what installing it would ask the server admin to confirm,
 * and whether a plugin with its slug is installed already.
 */
export interface PluginArtifactReceipt {
  readonly artifact: PluginArtifact;
  readonly directory: PluginArtifactDirectory;
  readonly assessment: PluginInstallAssessment;
  /** The plugin row with the artifact's slug, if any; `version` is that row's. */
  readonly installedPlugin: {
    readonly state: 'none' | 'installed' | 'uninstalled';
    readonly version: string | null;
  };
}

export interface ReceivePluginArtifactByLinkInput {
  readonly url: string;
  /** The checksum the server admin expects, in either case, with or without spaces around it. */
  readonly expectedSha256: string;
  readonly actorId: string;
}

export interface ReceivePluginArtifactUploadInput {
  /** Where the upload storage wrote the archive. Once called, the receiver owns it and removes it. */
  readonly archivePath: string;
  /** The archive's checksum and size, which the upload storage counted as the bytes arrived. */
  readonly sha256: string;
  readonly bytes: number;
  /** The checksum the server admin expects, in either case, with or without spaces around it. */
  readonly expectedSha256: string;
  readonly actorId: string;
}

/**
 * The checksum a server admin expects, trimmed and lowercased, so a value
 * copied in capitals or with spaces around it still compares (#1094). A value
 * that is not a checksum at all is a mismatch with nothing to compare it
 * against.
 */
export const normalizeExpectedSha256 = (raw: string): PluginArtifactSha256 => {
  const parsed = parseRequestedSha256(raw);

  if (parsed === null) {
    throw new PluginArtifactChecksumMismatchError(raw.trim().toLowerCase(), null);
  }

  return parsed;
};

/** A received archive, once its bytes are counted. */
interface ReceivedArchive {
  readonly archivePath: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The link it came from; null for an upload. */
  readonly url: string | null;
}

/**
 * The plugin artifact directory `placePluginArtifact` names by slug and
 * checksum, `<root>/<slug>/<sha256>/`.
 */
const placedDirectory = (pluginsRoot: string, slug: string, sha256: PluginArtifactSha256): PluginArtifactDirectory => {
  const rootDir = join(pluginsRoot, slug, sha256);

  return {
    slug,
    sha256,
    rootDir,
    manifestPath: join(rootDir, PLUGIN_MANIFEST_FILENAME),
    packageJsonPath: join(rootDir, PLUGIN_PACKAGE_JSON_FILENAME),
  };
};

/**
 * A link with a username or password in it (`https://user:token@host/…`).
 * The link is recorded on the artifact's row, then as the installed plugin's
 * provenance, which the plugin inventory serves, and on its installed event,
 * so a secret in it would leak. A link that does not parse is left to the
 * download, which refuses it as not usable.
 */
const carriesCredentials = (link: string): boolean => {
  try {
    const url = new URL(link);
    return url.username !== '' || url.password !== '';
  } catch {
    return false;
  }
};

/**
 * The posted link as it is recorded: without its query or fragment (#1094).
 * A presigned or tokenized link (`?X-Amz-Signature=…`, `?token=…`) carries
 * its secret there, and the record is served to everyone who may read the
 * plugin inventory. Such a link expires anyway, so its query says nothing
 * lasting about where the artifact came from. The download itself uses the
 * whole link. A secret in the path cannot be told apart from the path, and
 * is recorded with it.
 */
export const recordedLink = (link: string): string => {
  const url = new URL(link);
  url.search = '';
  url.hash = '';

  return url.toString();
};

/**
 * Whether `archivePath` names a file directly in `<root>/.incoming/`, the
 * only place the upload storage writes. A comparison of resolved paths, so
 * `..` cannot step out; no file is touched to decide.
 */
const isIncomingArchive = (archivePath: string, pluginsRoot: string): boolean =>
  dirname(resolve(archivePath)) === resolve(pluginsRoot, INCOMING_DIRNAME);

/**
 * The outbound HTTP policy reports a host that does not resolve (no such name, a
 * resolver that is down, an empty or malformed answer) as a rejection with
 * the reason `dns-failure`, on the first hop or on a redirect's. No rule
 * refused an address there: there was no address to judge.
 */
const unresolvable = (err: unknown): boolean =>
  (err instanceof SsrfRejectionError && err.reason === 'dns-failure') ||
  (err instanceof RedirectToDisallowedTargetError && err.cause.reason === 'dns-failure');

/**
 * What a failed download means for a plugin artifact (#1094). A link the
 * outbound HTTP policy or URL parsing refuses is refused before anything is kept;
 * a download that fails once allowed failed at the remote end or on the way.
 * A host that does not resolve is unreachable, not refused, so a mistyped
 * link or a resolver outage does not read as the policy's doing. The
 * service's own error is kept as the cause, for the operator's log. A
 * file-system error on the destination is the server's own, and propagates
 * as it is.
 */
const artifactDownloadError = (err: unknown): unknown => {
  const options = { cause: err };

  if (unresolvable(err)) {
    return new PluginArtifactDownloadFailedError('unreachable', null, options);
  }
  if (err instanceof InvalidRequestUrlError) {
    return new PluginArtifactLinkRefusedError('invalid-link', options);
  }
  if (err instanceof SsrfRejectionError) {
    return new PluginArtifactLinkRefusedError('blocked-by-policy', options);
  }
  if (err instanceof RedirectToDisallowedTargetError) {
    return new PluginArtifactLinkRefusedError('redirect-blocked', options);
  }
  if (err instanceof RedirectLimitExceededError) {
    return new PluginArtifactLinkRefusedError('too-many-redirects', options);
  }
  if (err instanceof RequestTimeoutError) {
    return new PluginArtifactDownloadFailedError('timeout', null, options);
  }
  if (err instanceof OutboundNetworkError) {
    return new PluginArtifactDownloadFailedError('unreachable', null, options);
  }
  if (err instanceof ResponseTooLargeError) {
    return new PluginArtifactTooLargeError(err.limitBytes, options);
  }

  return err;
};

/**
 * Receives a plugin artifact, by link or by upload, so a server admin can
 * review what it asks for before installing it by its checksum (#1094).
 *
 * Every path checks the actor's authority first, before it reads a byte of
 * input. Both receive paths then take the same steps: compare the checksum
 * the server admin expects with the bytes that arrived, extract the archive
 * under the archive rules, place it at `<pluginsRoot>/<slug>/<sha256>/`,
 * confirm and assess the directory, and record the artifact with an expiry.
 * Scratch files under `<pluginsRoot>/.incoming/` are removed whatever
 * happens.
 *
 * A failure before placement keeps nothing. A failure after it leaves the
 * placed directory, with no row, for the sweep to remove once it has aged:
 * an identical post may have found the same directory already present, and
 * be about to record it.
 */
@Injectable()
export class PluginArtifactReceiver {
  private readonly logger = new Logger(PluginArtifactReceiver.name);

  constructor(
    private readonly http: SecureHttpService,
    private readonly store: PluginArtifactStore,
    private readonly installer: PluginInstallerService,
    private readonly directories: PluginDirectoryResolverService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly db: DatabaseService,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Downloads the plugin artifact through the outbound HTTP policy, under the
   * 100 MiB cap and one 15-minute limit, and receives it. A link with a
   * username or password in it is refused before anything is fetched or
   * written: the link becomes the plugin's provenance, which others read.
   * For the same reason the link is recorded without its query.
   */
  async receiveByLink(input: ReceivePluginArtifactByLinkInput): Promise<PluginArtifactReceipt> {
    await this.assertServerAdmin(input.actorId);
    const expected = normalizeExpectedSha256(input.expectedSha256);

    if (carriesCredentials(input.url)) {
      throw new PluginArtifactLinkRefusedError('invalid-link');
    }

    return this.withIncoming(async (incoming) => {
      const written = await this.download(input.url, incoming.archivePath);

      return this.accept(
        incoming.extractDir,
        {
          archivePath: incoming.archivePath,
          sha256: written.sha256,
          bytes: written.bytes,
          // It parsed: the download succeeded.
          url: recordedLink(input.url),
        },
        expected,
        input.actorId,
      );
    });
  }

  /**
   * Receives an archive the upload storage has written. Once called, the
   * receiver owns that archive and removes it, whatever happens. The upload
   * interceptor's own removal is the backstop for a request that never gets
   * here.
   *
   * Only an archive directly in `<root>/.incoming/` is the receiver's: a path
   * anywhere else is a caller's bug, refused with its file neither read nor
   * removed.
   */
  async receiveUpload(input: ReceivePluginArtifactUploadInput): Promise<PluginArtifactReceipt> {
    // Decided before anything can throw, because the `finally` needs it.
    const contained = isIncomingArchive(input.archivePath, this.options.pluginsRoot);

    try {
      await this.assertServerAdmin(input.actorId);

      if (!contained) {
        throw new Error(
          `The uploaded archive ${JSON.stringify(input.archivePath)} is not in the incoming directory of the ` +
            'plugins root, so it is neither read nor removed',
        );
      }

      const expected = normalizeExpectedSha256(input.expectedSha256);

      // A cheap second line behind the upload storage's own cap.
      if (input.bytes > PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES) {
        throw new PluginArtifactTooLargeError(PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES);
      }

      return await this.withIncoming((incoming) =>
        this.accept(
          incoming.extractDir,
          { archivePath: input.archivePath, sha256: input.sha256, bytes: input.bytes, url: null },
          expected,
          input.actorId,
        ),
      );
    } finally {
      if (contained) {
        await this.cleanUp(rm(input.archivePath, { force: true }));
      }
    }
  }

  /**
   * A received artifact, read back for `GET /plugins/artifacts/:sha256`
   * (#1094). Read-only: the row's expiry does not move, and the row stays even
   * when its directory is gone. Anything but a live artifact whose directory
   * is in place answers not found, a value that is not a checksum included.
   * The checksum is taken in either case, as the post takes it.
   */
  async read(sha256: string, actorId: string): Promise<PluginArtifactReceipt> {
    await this.assertServerAdmin(actorId);

    const checksum = parseRequestedSha256(sha256);
    if (checksum === null) {
      throw new PluginArtifactNotFoundError(sha256);
    }

    const artifact = await this.store.findLive(checksum, new Date());
    if (artifact === null) {
      throw new PluginArtifactNotFoundError(checksum);
    }

    const directory = await this.locate(artifact.slug, checksum);
    const assessment = await this.installer.assess(directory);

    return { artifact, directory, assessment, installedPlugin: await this.installedPlugin(artifact.slug) };
  }

  /** Before anything else, on every path: anyone but a server admin triggers no read, write or download (#1094). */
  private async assertServerAdmin(actorId: string): Promise<void> {
    if (!(await this.authority.isServerAdmin(actorId))) {
      throw new PluginInstallAuthorityError(actorId);
    }
  }

  /** Runs `step` with a fresh incoming workspace, and removes the workspace afterwards. */
  private async withIncoming<T>(step: (incoming: IncomingWorkspace) => Promise<T>): Promise<T> {
    const incoming = await allocateIncoming(this.options.pluginsRoot);

    try {
      return await step(incoming);
    } finally {
      await this.cleanUp(incoming.cleanup());
    }
  }

  private async download(
    url: string,
    destination: string,
  ): Promise<{ readonly sha256: string; readonly bytes: number }> {
    const result = await this.http
      .download(url, {
        destination,
        maxBytes: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES,
        timeoutMs: PLUGIN_ARTIFACT_DOWNLOAD_TIMEOUT_MS,
      })
      .catch((err: unknown) => {
        const mapped = artifactDownloadError(err);
        this.logDownloadFailure(url, mapped, err);
        throw mapped;
      });

    // Any status but 2xx: the service wrote nothing.
    if (result.written === null) {
      const refused = new PluginArtifactDownloadFailedError('upstream-status', result.status);
      this.logDownloadFailure(url, refused);
      throw refused;
    }

    return result.written;
  }

  /** The steps both receive paths share once the archive's bytes are counted. */
  private async accept(
    extractDir: string,
    archive: ReceivedArchive,
    expected: PluginArtifactSha256,
    actorId: string,
  ): Promise<PluginArtifactReceipt> {
    if (archive.sha256 !== expected) {
      throw new PluginArtifactChecksumMismatchError(expected, archive.sha256);
    }

    await extractPluginArchive(archive.archivePath, extractDir);
    const slug = await readArtifactSlug(extractDir);
    await placePluginArtifact(extractDir, this.options.pluginsRoot, slug, expected);

    // Placed: from here a failure leaves the directory for the sweep.
    const directory = await this.directories.confirm(placedDirectory(this.options.pluginsRoot, slug, expected));
    const assessment = await this.installer.assess(directory);
    // Every read comes before the row is written, so any failure leaves no row.
    const installedPlugin = await this.installedPlugin(slug);

    const artifact = await this.store.recordReceived(
      {
        sha256: expected,
        slug,
        version: assessment.validated.manifest.version,
        compressedBytes: archive.bytes,
        url: archive.url,
        registrySlug: null,
        receivedById: actorId,
      },
      new Date(),
    );

    return { artifact, directory, assessment, installedPlugin };
  }

  /** The artifact's directory, as the resolver finds and confirms it; a missing one is not found. */
  private async locate(slug: string, sha256: PluginArtifactSha256): Promise<PluginArtifactDirectory> {
    try {
      return await this.directories.confirm(await this.directories.resolve(slug, sha256));
    } catch (err) {
      if (err instanceof PluginDirectoryNotFoundError) {
        throw new PluginArtifactNotFoundError(sha256);
      }

      throw err;
    }
  }

  /** Whether a plugin with this slug is installed, uninstalled, or has no row at all. */
  private async installedPlugin(slug: string): Promise<PluginArtifactReceipt['installedPlugin']> {
    const plugin = await this.db.plugin.findUnique({
      where: { slug },
      select: { version: true, uninstalledAt: true },
    });

    if (plugin === null) {
      return { state: 'none', version: null };
    }

    return { state: plugin.uninstalledAt === null ? 'installed' : 'uninstalled', version: plugin.version };
  }

  /**
   * The HTTP error carries only the reason a server admin reads, so the
   * secure-http error behind it, which says whether a TLS or DNS failure sat
   * behind `unreachable`, is logged here for the operator (#1094). Only the
   * link's host and the cause's name and code go in: the full link may carry
   * a query token. A file-system error on the destination passes through
   * unmapped and is not a download failure.
   */
  private logDownloadFailure(url: string, mapped: unknown, cause?: unknown): void {
    if (!(mapped instanceof PluginArtifactDownloadFailedError) && !(mapped instanceof PluginArtifactLinkRefusedError)) {
      return;
    }

    let host = 'an unparsable link';
    try {
      host = new URL(url).host;
    } catch {
      // The link did not parse; the refusal says so.
    }

    // Name, code and reason only. The reason is a fixed vocabulary (a DNS
    // failure reads differently from a policy block), where a message could
    // quote the link.
    const named = (value: unknown): string => {
      if (!(value instanceof Error)) {
        return 'a non-error value';
      }
      const { code, reason } = value as { code?: unknown; reason?: unknown };
      const details = [
        typeof code === 'string' ? `code ${code}` : null,
        typeof reason === 'string' ? `reason ${reason}` : null,
      ].filter((detail) => detail !== null);
      return details.length > 0 ? `${value.name} (${details.join(', ')})` : value.name;
    };
    const inner = cause instanceof Error && cause.cause !== undefined ? `, caused by ${named(cause.cause)}` : '';
    const hasUpstreamStatus = mapped instanceof PluginArtifactDownloadFailedError && mapped.upstreamStatus !== null;
    const detail =
      cause === undefined
        ? hasUpstreamStatus
          ? `HTTP status ${mapped.upstreamStatus}`
          : ''
        : `${named(cause)}${inner}`;

    this.logger.warn(`Downloading a plugin artifact from ${host} failed as ${mapped.name}: ${detail}`);
  }

  /**
   * Waits for a removal of scratch files. One that fails is logged, not
   * thrown, so it never replaces the receipt or the error the caller should
   * see; the sweep removes what it leaves under `.incoming`.
   */
  private async cleanUp(removal: Promise<void>): Promise<void> {
    await removal.catch((err: unknown) => {
      this.logger.warn(
        `Scratch files of a received plugin artifact could not be removed; the sweep will remove them: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
}
