import type { DatabaseService, PluginArtifact } from '@bge/database';
import {
  buildPluginModuleOptions,
  PluginDirectoryLayoutError,
  PluginDirectoryResolverService,
  PluginInstallAuthorityError,
  PluginInstallManifestError,
  type PluginGrantAuthorityService,
  type PluginInstallAssessment,
  type PluginInstallerService,
} from '@bge/plugin';
import {
  DnsResolutionError,
  IpPolicyService,
  NoopOutboundHttpObserver,
  RedirectToDisallowedTargetError,
  RequestTimeoutError,
  SecureHttpService,
  SsrfRejectionError,
  type DnsResolver,
  type HttpDispatcherFactory,
  type ResolvedAddress,
  type SafeHttpPolicyService,
  type SafeHttpPolicySnapshot,
} from '@bge/secure-http';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { PluginArtifactDirectory } from '@boardgamesempire/plugin-contract';
import { PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, type Dispatcher } from 'undici';
import {
  PluginArchiveRefusedError,
  PluginArtifactChecksumMismatchError,
  PluginArtifactDownloadFailedError,
  PluginArtifactLinkRefusedError,
  PluginArtifactNotFoundError,
  PluginArtifactTooLargeError,
} from '../artifacts.errors';
import {
  PLUGIN_ARTIFACT_TTL_MS,
  type PluginArtifactStore,
  type RecordReceivedArtifactInput,
} from '../store/plugin-artifact.store';
import { buildPluginTarball, type PluginTarballEntry } from '../testing/plugin-tarball';
import { allocateIncoming } from '../workspace/incoming';
import {
  normalizeExpectedSha256,
  PLUGIN_ARTIFACT_DOWNLOAD_TIMEOUT_MS,
  PluginArtifactReceiver,
  type PluginArtifactReceipt,
} from './plugin-artifact.receiver';

const ADMIN = 'admin-1';
const HOST = 'artifacts.example.test';
const BLOCKED_HOST = 'internal.example.test';
/** A hostname nobody registered: the fake resolver answers NXDOMAIN, as for a typo. */
const UNRESOLVABLE_HOST = 'typo.example.test';
const PATH = '/demo-sink-1.2.0.tgz';
const LINK = `https://${HOST}${PATH}`;
const MANIFEST = { slug: 'demo-sink', version: '1.2.0' };

const ENTRIES: PluginTarballEntry[] = [
  { name: 'package/manifest.json', content: JSON.stringify(MANIFEST) },
  { name: 'package/package.json', content: JSON.stringify({ name: 'demo-sink', version: '1.2.0', main: 'index.js' }) },
  { name: 'package/index.js', content: 'module.exports = () => ({});\n' },
];

/** An archive that extracts under the rules, but whose manifest names no plugin slug. */
const NOT_A_SLUG: PluginTarballEntry[] = [
  { name: 'package/manifest.json', content: JSON.stringify({ slug: 'Not A Slug', version: '1.2.0' }) },
  { name: 'package/package.json', content: '{}' },
];

/** A public address the outbound HTTP policy allows, and a private one it refuses. */
const ADDRESSES: Readonly<Record<string, string>> = { [HOST]: '8.8.8.8', [BLOCKED_HOST]: '10.0.0.5' };

class FakeDnsResolver implements DnsResolver {
  async resolveAll(hostname: string): Promise<ResolvedAddress[]> {
    const address = ADDRESSES[hostname];
    if (address === undefined) {
      throw new DnsResolutionError(hostname, new Error('NXDOMAIN'));
    }

    return [{ address, family: 4 }];
  }
}

const POLICY: SafeHttpPolicySnapshot = {
  defaultTimeoutMs: 5_000,
  defaultMaxRedirects: 5,
  strictMode: true,
  allowedHosts: [],
  allowedCidrs: [],
  blockedHosts: [],
  blockedCidrs: [],
};

/**
 * The dispatcher factory is the service's one seam to undici, so every hop
 * goes through the MockAgent. Closing a hop's dispatcher must not close the
 * agent the next hop needs.
 */
const mockDispatchers = (agent: MockAgent): HttpDispatcherFactory =>
  ({
    build: (): Dispatcher =>
      new Proxy(agent, {
        get(target, prop) {
          if (prop === 'close' || prop === 'destroy') {
            return async () => undefined;
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  }) as unknown as HttpDispatcherFactory;

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** What the runtime's assess() reports, read from the directory it was handed, so two answers can be compared. */
const assessmentOf = async (directory: PluginArtifactDirectory): Promise<PluginInstallAssessment> =>
  ({
    validated: { manifest: JSON.parse(await readFile(directory.manifestPath, 'utf8')), warnings: [] },
    serverChecks: [],
    corePermissions: new Map(),
    criticalSlugsToReenter: [],
    analysis: { findings: [], scannedFileCount: 1, deepScannedFileCount: 0, truncated: false },
    forbiddenImportsToAccept: [],
  }) as unknown as PluginInstallAssessment;

const artifactRow = (input: RecordReceivedArtifactInput, now: Date): PluginArtifact => ({
  ...input,
  receivedAt: now,
  expiresAt: new Date(now.getTime() + PLUGIN_ARTIFACT_TTL_MS),
});

/** The error a call rejects with; the test fails if the call resolves. */
const failure = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (err: unknown) => err,
  );

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('normalizeExpectedSha256 (#1094)', () => {
  it('trims and lowercases an expected checksum (#1094)', () => {
    expect(normalizeExpectedSha256(`  ${'AB'.repeat(32)}\t\n`)).toBe('ab'.repeat(32));
  });

  it.each(['', 'not a checksum', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `../${'a'.repeat(61)}`])(
    'refuses %j as not a checksum, with no actual checksum (#1094)',
    (raw) => {
      const err = (() => {
        try {
          normalizeExpectedSha256(raw);
        } catch (thrown) {
          return thrown;
        }
        throw new Error('expected a refusal');
      })();

      expect(err).toBeInstanceOf(PluginArtifactChecksumMismatchError);
      expect(err).toMatchObject({ expectedSha256: raw.trim().toLowerCase(), actualSha256: null });
      expect((err as Error).message).toContain('is not a SHA-256 checksum');
    },
  );
});

describe('PluginArtifactReceiver (#1094)', () => {
  let root: string;
  let mockAgent: MockAgent;
  let http: SecureHttpService;
  let store: { recordReceived: jest.Mock; findLive: jest.Mock; refreshForInstall: jest.Mock; remove: jest.Mock };
  let installer: { assess: jest.Mock };
  let resolver: PluginDirectoryResolverService;
  let authority: { isServerAdmin: jest.Mock };
  let db: MockDatabaseService;
  let receiver: PluginArtifactReceiver;
  let bytes: Buffer;
  let sha256: string;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    root = await mkdtemp(join(tmpdir(), 'bge-receive-'));
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();

    http = new SecureHttpService(
      { current: () => POLICY } as unknown as SafeHttpPolicyService,
      new IpPolicyService(new FakeDnsResolver()),
      mockDispatchers(mockAgent),
      new NoopOutboundHttpObserver(),
    );
    store = {
      recordReceived: jest.fn(async (input: RecordReceivedArtifactInput, now: Date) => artifactRow(input, now)),
      findLive: jest.fn(),
      refreshForInstall: jest.fn(),
      remove: jest.fn(),
    };
    installer = { assess: jest.fn(assessmentOf) };
    // The real resolver: the placed directory must be one it confirms.
    resolver = new PluginDirectoryResolverService(buildPluginModuleOptions({ pluginsRoot: root }));
    authority = { isServerAdmin: jest.fn().mockResolvedValue(true) };
    db = createMockDatabaseService();
    db.plugin.findUnique.mockResolvedValue(null);

    receiver = new PluginArtifactReceiver(
      http,
      store as unknown as PluginArtifactStore,
      installer as unknown as PluginInstallerService,
      resolver,
      authority as unknown as PluginGrantAuthorityService,
      db as unknown as DatabaseService,
      buildPluginModuleOptions({ pluginsRoot: root }),
    );

    bytes = await buildPluginTarball(ENTRIES);
    sha256 = sha256Of(bytes);
  });

  afterEach(async () => {
    await mockAgent.close();
    await rm(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const origin = () => mockAgent.get(`https://${HOST}`);

  const serve = (): void => {
    origin().intercept({ path: PATH, method: 'GET' }).reply(200, bytes);
  };

  const byLink = (overrides: Partial<Parameters<PluginArtifactReceiver['receiveByLink']>[0]> = {}) =>
    receiver.receiveByLink({ url: LINK, expectedSha256: sha256, actorId: ADMIN, ...overrides });

  /** Puts bytes where the upload storage writes them: `<root>/.incoming/<id>.tgz`. */
  const uploaded = async (content: Buffer = bytes) => {
    const { archivePath } = await allocateIncoming(root);
    await writeFile(archivePath, content);
    return { archivePath, sha256: sha256Of(content), bytes: content.length };
  };

  const byUpload = async (
    overrides: Partial<Parameters<PluginArtifactReceiver['receiveUpload']>[0]> = {},
  ): Promise<PluginArtifactReceipt> =>
    receiver.receiveUpload({ ...(await uploaded()), expectedSha256: sha256, actorId: ADMIN, ...overrides });

  /** What is left under `<root>/.incoming`; none at all when it was never created. */
  const incoming = (): Promise<string[]> => readdir(join(root, '.incoming')).catch(() => []);

  const placedAt = async (): Promise<string> => join(await realpath(root), 'demo-sink', sha256);

  describe('receiveByLink', () => {
    it('downloads the artifact, places it at <root>/<slug>/<sha256>, assesses it and records the link (#1094)', async () => {
      serve();
      const download = jest.spyOn(http, 'download');

      const receipt = await byLink();

      const rootDir = await placedAt();
      expect(download).toHaveBeenCalledWith(LINK, {
        destination: expect.stringContaining(join(root, '.incoming')),
        maxBytes: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES,
        timeoutMs: 15 * 60 * 1000,
      });
      expect(receipt.directory).toEqual({
        slug: 'demo-sink',
        sha256,
        rootDir,
        manifestPath: join(rootDir, 'manifest.json'),
        packageJsonPath: join(rootDir, 'package.json'),
      });
      expect(JSON.parse(await readFile(join(rootDir, 'manifest.json'), 'utf8'))).toEqual(MANIFEST);
      expect(installer.assess).toHaveBeenCalledWith(receipt.directory);
      expect(receipt.assessment).toEqual(await assessmentOf(receipt.directory));
      expect(store.recordReceived).toHaveBeenCalledWith(
        {
          sha256,
          slug: 'demo-sink',
          version: '1.2.0',
          compressedBytes: bytes.length,
          url: LINK,
          registrySlug: null,
          receivedById: ADMIN,
        },
        expect.any(Date),
      );
      expect(receipt.artifact).toBe(await store.recordReceived.mock.results[0]?.value);
      expect(receipt.installedPlugin).toEqual({ state: 'none', version: null });
      expect(await incoming()).toEqual([]);
    });

    it('allows the whole download 15 minutes (#1094)', () => {
      expect(PLUGIN_ARTIFACT_DOWNLOAD_TIMEOUT_MS).toBe(15 * 60 * 1000);
    });

    it('a checksum mismatch by link keeps nothing and writes no row (#1094)', async () => {
      serve();
      const expected = sha256Of(Buffer.from('another plugin artifact'));

      const err = await failure(byLink({ expectedSha256: expected }));

      expect(err).toBeInstanceOf(PluginArtifactChecksumMismatchError);
      expect(err).toMatchObject({ expectedSha256: expected, actualSha256: sha256 });
      expect(await incoming()).toEqual([]);
      expect(await exists(join(root, 'demo-sink'))).toBe(false);
      expect(store.recordReceived).not.toHaveBeenCalled();
    });

    it('accepts an expected checksum in capitals with spaces around it (#1094)', async () => {
      serve();

      const receipt = await byLink({ expectedSha256: `  ${sha256.toUpperCase()}\t\n` });

      expect(receipt.directory.sha256).toBe(sha256);
      expect(store.recordReceived).toHaveBeenCalledWith(expect.objectContaining({ sha256 }), expect.any(Date));
    });

    it('refuses anyone but a server admin before reading a byte (#1094)', async () => {
      authority.isServerAdmin.mockResolvedValue(false);
      serve();

      // An expected value that is not a checksum would be refused too: the
      // authority refusal shows the actor is checked before any input is.
      const err = await failure(byLink({ actorId: 'member-1', expectedSha256: 'not a checksum' }));

      expect(err).toBeInstanceOf(PluginInstallAuthorityError);
      expect(authority.isServerAdmin).toHaveBeenCalledWith('member-1');
      expect(mockAgent.pendingInterceptors()).toHaveLength(1);
      expect(await exists(join(root, '.incoming'))).toBe(false);
      expect(installer.assess).not.toHaveBeenCalled();
      expect(store.recordReceived).not.toHaveBeenCalled();
    });

    it('a link to a blocked address is refused as blocked-by-policy (#1094)', async () => {
      // No interceptor answers for the blocked host. Had the policy let the
      // request through, it would fail as unreachable instead.
      const err = await failure(byLink({ url: `https://${BLOCKED_HOST}${PATH}` }));

      expect(err).toBeInstanceOf(PluginArtifactLinkRefusedError);
      expect(err).toMatchObject({ name: 'PluginArtifactLinkRefusedError', reason: 'blocked-by-policy' });
      expect(await incoming()).toEqual([]);
      expect(store.recordReceived).not.toHaveBeenCalled();
    });

    it('logs a failed download for the operator with the host and the cause, never the full link (#1094)', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      origin()
        .intercept({ path: `${PATH}?token=s3cret` })
        .replyWithError(new Error('connect ECONNREFUSED'));

      const err = await failure(byLink({ url: `${LINK}?token=s3cret` }));

      expect(err).toBeInstanceOf(PluginArtifactDownloadFailedError);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(HOST));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('PluginArtifactDownloadFailedError'));
      // The cause's own code, so the line is not only the mapped error's name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OUTBOUND_NETWORK_ERROR'));
      const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).not.toContain('s3cret');
      expect(logged).not.toContain(PATH);
    });

    it('logs the reason behind an unresolvable host, so a DNS failure does not read as a policy block (#1094)', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');

      await failure(byLink({ url: `https://${UNRESOLVABLE_HOST}${PATH}?token=s3cret` }));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining(UNRESOLVABLE_HOST));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reason dns-failure'));
      expect(warn.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('s3cret');
    });

    it('logs a link that answers with an error status, with the host and the status (#1094)', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      origin()
        .intercept({ path: `${PATH}?token=s3cret` })
        .reply(404, 'gone');

      await failure(byLink({ url: `${LINK}?token=s3cret` }));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining(HOST));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP status 404'));
      expect(warn.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('s3cret');
    });

    // The link is recorded on the row, then as the installed plugin's
    // provenance, which GET /plugins serves: a secret in it would leak.
    it.each([`https://user:token@${HOST}${PATH}`, `https://token@${HOST}${PATH}`, `https://:secret@${HOST}${PATH}`])(
      'refuses a link that carries credentials, %s, before any request (#1094)',
      async (url) => {
        serve();

        const err = await failure(byLink({ url }));

        expect(err).toBeInstanceOf(PluginArtifactLinkRefusedError);
        expect(err).toMatchObject({ reason: 'invalid-link' });
        expect(mockAgent.pendingInterceptors()).toHaveLength(1);
        expect(await exists(join(root, '.incoming'))).toBe(false);
        expect(store.recordReceived).not.toHaveBeenCalled();
      },
    );

    it('refuses anyone but a server admin for authority before it looks at the link, credentials and all (#1094)', async () => {
      authority.isServerAdmin.mockResolvedValue(false);
      serve();

      const err = await failure(byLink({ actorId: 'member-1', url: `https://user:token@${HOST}${PATH}` }));

      expect(err).toBeInstanceOf(PluginInstallAuthorityError);
      expect(mockAgent.pendingInterceptors()).toHaveLength(1);
      expect(await exists(join(root, '.incoming'))).toBe(false);
    });

    it('records the posted link, not the address a redirect led to (#1094)', async () => {
      origin()
        .intercept({ path: PATH })
        .reply(302, '', { headers: { location: `https://${HOST}/cdn${PATH}?signature=abc` } });
      origin()
        .intercept({ path: `/cdn${PATH}?signature=abc` })
        .reply(200, bytes);

      await byLink();

      mockAgent.assertNoPendingInterceptors();
      expect(store.recordReceived).toHaveBeenCalledWith(expect.objectContaining({ url: LINK }), expect.any(Date));
    });

    it('downloads from the whole link but records it without its query or fragment, where a token sits (#1094)', async () => {
      origin()
        .intercept({ path: `${PATH}?X-Amz-Signature=s3cret&token=s3cret` })
        .reply(200, bytes);

      const receipt = await byLink({ url: `${LINK}?X-Amz-Signature=s3cret&token=s3cret#also-s3cret` });

      mockAgent.assertNoPendingInterceptors();
      expect(store.recordReceived).toHaveBeenCalledWith(expect.objectContaining({ url: LINK }), expect.any(Date));
      expect(JSON.stringify(receipt.artifact)).not.toContain('s3cret');
    });

    it('a manifest whose slug is not a plugin slug keeps nothing, by link (#1094)', async () => {
      const content = await buildPluginTarball(NOT_A_SLUG);
      origin().intercept({ path: PATH }).reply(200, content);

      const err = await failure(byLink({ expectedSha256: sha256Of(content) }));

      expect(err).toBeInstanceOf(PluginArchiveRefusedError);
      expect(err).toMatchObject({ rule: 'manifest-slug' });
      expect(await readdir(root)).toEqual(['.incoming']);
      expect(await incoming()).toEqual([]);
      expect(store.recordReceived).not.toHaveBeenCalled();
    });

    describe('a download that fails keeps nothing and says why (#1094)', () => {
      it.each<[string, () => string, new (...args: never[]) => Error, Record<string, unknown>]>([
        ['a link that is not a URL', () => 'not a link', PluginArtifactLinkRefusedError, { reason: 'invalid-link' }],
        [
          'a link that is not http or https',
          () => `ftp://${HOST}${PATH}`,
          PluginArtifactLinkRefusedError,
          { reason: 'invalid-link' },
        ],
        [
          'a redirect to a blocked address',
          () => {
            origin()
              .intercept({ path: PATH })
              .reply(302, '', { headers: { location: `http://${BLOCKED_HOST}${PATH}` } });
            return LINK;
          },
          PluginArtifactLinkRefusedError,
          { reason: 'redirect-blocked' },
        ],
        [
          'a link that redirects past the limit',
          () => {
            origin()
              .intercept({ path: PATH })
              .reply(302, '', { headers: { location: LINK } })
              .persist();
            return LINK;
          },
          PluginArtifactLinkRefusedError,
          { reason: 'too-many-redirects' },
        ],
        [
          'a link whose host does not resolve, which no policy refused',
          () => `https://${UNRESOLVABLE_HOST}${PATH}`,
          PluginArtifactDownloadFailedError,
          { reason: 'unreachable', upstreamStatus: null, cause: expect.any(SsrfRejectionError) },
        ],
        [
          'a redirect to a host that does not resolve',
          () => {
            origin()
              .intercept({ path: PATH })
              .reply(302, '', { headers: { location: `https://${UNRESOLVABLE_HOST}${PATH}` } });
            return LINK;
          },
          PluginArtifactDownloadFailedError,
          { reason: 'unreachable', upstreamStatus: null, cause: expect.any(RedirectToDisallowedTargetError) },
        ],
        [
          'a link that answers 404',
          () => {
            origin().intercept({ path: PATH }).reply(404, 'gone');
            return LINK;
          },
          PluginArtifactDownloadFailedError,
          { reason: 'upstream-status', upstreamStatus: 404 },
        ],
        [
          'a link the server cannot reach',
          () => {
            origin().intercept({ path: PATH }).replyWithError(new Error('connect ECONNREFUSED'));
            return LINK;
          },
          PluginArtifactDownloadFailedError,
          { reason: 'unreachable', upstreamStatus: null },
        ],
        [
          'a body that declares more than 100 MiB',
          () => {
            origin()
              .intercept({ path: PATH })
              .reply(200, bytes, { headers: { 'content-length': String(PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES + 1) } });
            return LINK;
          },
          PluginArtifactTooLargeError,
          { limitBytes: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES },
        ],
      ])('%s (#1094)', async (_label, arrange, type, fields) => {
        const err = await failure(byLink({ url: arrange() }));

        expect(err).toBeInstanceOf(type);
        expect(err).toMatchObject({ name: type.name, ...fields });
        expect(await incoming()).toEqual([]);
        expect(store.recordReceived).not.toHaveBeenCalled();
      });

      it('a download that runs out of time (#1094)', async () => {
        // The limit is 15 minutes, so the timeout itself is the service's to
        // test; here it is the answer the service gives.
        jest
          .spyOn(http, 'download')
          .mockRejectedValue(new RequestTimeoutError(LINK, PLUGIN_ARTIFACT_DOWNLOAD_TIMEOUT_MS));

        const err = await failure(byLink());

        expect(err).toBeInstanceOf(PluginArtifactDownloadFailedError);
        expect(err).toMatchObject({ reason: 'timeout', upstreamStatus: null });
        expect(await incoming()).toEqual([]);
      });

      it('a file-system failure on the destination propagates as it is (#1094)', async () => {
        const diskFull = Object.assign(new Error('ENOSPC: no space left on device, write'), {
          code: 'ENOSPC',
          syscall: 'write',
        });
        jest.spyOn(http, 'download').mockRejectedValue(diskFull);

        await expect(byLink()).rejects.toBe(diskFull);
        expect(await incoming()).toEqual([]);
      });
    });
  });

  describe('receiveUpload', () => {
    it('places an uploaded artifact, records no link, and removes the upload (#1094)', async () => {
      const upload = await uploaded();

      const receipt = await receiver.receiveUpload({ ...upload, expectedSha256: sha256, actorId: ADMIN });

      expect(receipt.directory.rootDir).toBe(await placedAt());
      expect(store.recordReceived).toHaveBeenCalledWith(
        {
          sha256,
          slug: 'demo-sink',
          version: '1.2.0',
          compressedBytes: bytes.length,
          url: null,
          registrySlug: null,
          receivedById: ADMIN,
        },
        expect.any(Date),
      );
      expect(await exists(upload.archivePath)).toBe(false);
      expect(await incoming()).toEqual([]);
    });

    it('a checksum mismatch by upload keeps nothing and writes no row (#1094)', async () => {
      const expected = sha256Of(Buffer.from('another plugin artifact'));

      const err = await failure(byUpload({ expectedSha256: expected }));

      expect(err).toBeInstanceOf(PluginArtifactChecksumMismatchError);
      expect(err).toMatchObject({ expectedSha256: expected, actualSha256: sha256 });
      expect(await incoming()).toEqual([]);
      expect(await exists(join(root, 'demo-sink'))).toBe(false);
      expect(store.recordReceived).not.toHaveBeenCalled();
    });

    it('refuses an upload by anyone but a server admin before reading a byte, and removes the upload (#1094)', async () => {
      authority.isServerAdmin.mockResolvedValue(false);

      // Neither the bad checksum nor the size is reached.
      const err = await failure(
        byUpload({
          actorId: 'member-1',
          expectedSha256: 'not a checksum',
          bytes: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES + 1,
        }),
      );

      expect(err).toBeInstanceOf(PluginInstallAuthorityError);
      expect(await incoming()).toEqual([]);
      expect(installer.assess).not.toHaveBeenCalled();
      expect(store.recordReceived).not.toHaveBeenCalled();
    });

    it('refuses an upload over 100 MiB with PluginArtifactTooLargeError (#1094)', async () => {
      const err = await failure(byUpload({ bytes: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES + 1 }));

      expect(err).toBeInstanceOf(PluginArtifactTooLargeError);
      expect(err).toMatchObject({ limitBytes: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES });
      expect(await incoming()).toEqual([]);
      expect(await exists(join(root, 'demo-sink'))).toBe(false);
    });

    it('accepts an upload of exactly 100 MiB (#1094)', async () => {
      // The size is the upload storage's count, which the receiver checks;
      // the file here is small.
      await byUpload({ bytes: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES });

      expect(store.recordReceived).toHaveBeenCalledWith(
        expect.objectContaining({ compressedBytes: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES }),
        expect.any(Date),
      );
    });

    it('two identical uploads at once both answer with the same assessment (#1094)', async () => {
      const uploads = [await uploaded(), await uploaded()];

      const receipts = await Promise.all(
        uploads.map((upload) => receiver.receiveUpload({ ...upload, expectedSha256: sha256, actorId: ADMIN })),
      );

      expect(receipts[1]?.assessment).toEqual(receipts[0]?.assessment);
      expect(receipts[1]?.directory).toEqual(receipts[0]?.directory);
      expect(await readdir(join(root, 'demo-sink'))).toEqual([sha256]);
      expect(await incoming()).toEqual([]);
      expect(store.recordReceived).toHaveBeenCalledTimes(2);
    });

    it('an archive the rules refuse keeps nothing and writes no row (#1094)', async () => {
      const hostile = await buildPluginTarball([...ENTRIES, { name: 'package/../escape.js', content: 'x' }]);

      const err = await failure(
        receiver.receiveUpload({ ...(await uploaded(hostile)), expectedSha256: sha256Of(hostile), actorId: ADMIN }),
      );

      expect(err).toBeInstanceOf(PluginArchiveRefusedError);
      expect(await incoming()).toEqual([]);
      expect(await exists(join(root, 'demo-sink'))).toBe(false);
      expect(store.recordReceived).not.toHaveBeenCalled();
    });

    it('a manifest whose slug is not a plugin slug keeps nothing, by upload (#1094)', async () => {
      const content = await buildPluginTarball(NOT_A_SLUG);

      const err = await failure(
        receiver.receiveUpload({ ...(await uploaded(content)), expectedSha256: sha256Of(content), actorId: ADMIN }),
      );

      expect(err).toBeInstanceOf(PluginArchiveRefusedError);
      expect(err).toMatchObject({ rule: 'manifest-slug' });
      expect(await readdir(root)).toEqual(['.incoming']);
      expect(await incoming()).toEqual([]);
      expect(store.recordReceived).not.toHaveBeenCalled();
    });

    describe('an archive path outside the incoming directory', () => {
      // The upload storage writes only `<root>/.incoming/<id>.tgz`; any other
      // path is a caller's bug, and its file is not the receiver's to touch.
      it.each<[string, () => Promise<string>]>([
        ['beside it', async () => join(root, 'elsewhere.tgz')],
        [
          'reached with ..',
          async () => {
            // The file system walks `.incoming/..` literally, so it must exist.
            await mkdir(join(root, '.incoming'), { recursive: true });
            return `${root}/.incoming/../elsewhere.tgz`;
          },
        ],
        [
          'below it',
          async () => {
            await mkdir(join(root, '.incoming', 'nested'), { recursive: true });
            return join(root, '.incoming', 'nested', 'elsewhere.tgz');
          },
        ],
      ])('is refused %s, and neither read nor removed (#1094)', async (_label, place) => {
        const archivePath = await place();
        await writeFile(archivePath, bytes);

        const err = await failure(
          receiver.receiveUpload({ archivePath, sha256, bytes: bytes.length, expectedSha256: sha256, actorId: ADMIN }),
        );

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).constructor).toBe(Error);
        expect(await readFile(archivePath)).toEqual(bytes);
        expect((await incoming()).filter((entry) => entry !== 'nested')).toEqual([]);
        expect(await exists(join(root, 'demo-sink'))).toBe(false);
        expect(installer.assess).not.toHaveBeenCalled();
        expect(store.recordReceived).not.toHaveBeenCalled();
      });

      it('is left alone for anyone but a server admin too, who is refused for authority first (#1094)', async () => {
        authority.isServerAdmin.mockResolvedValue(false);
        const archivePath = join(root, 'elsewhere.tgz');
        await writeFile(archivePath, bytes);

        const err = await failure(
          receiver.receiveUpload({
            archivePath,
            sha256,
            bytes: bytes.length,
            expectedSha256: sha256,
            actorId: 'member-1',
          }),
        );

        expect(err).toBeInstanceOf(PluginInstallAuthorityError);
        expect(await readFile(archivePath)).toEqual(bytes);
      });
    });
  });

  describe('after placement', () => {
    it('a manifest that fails validation leaves its placed directory for the sweep and no row (#1094)', async () => {
      installer.assess.mockRejectedValue(new PluginInstallManifestError('demo-sink', 'manifest validation failed'));

      const err = await failure(byUpload());

      expect(err).toBeInstanceOf(PluginInstallManifestError);
      expect(await exists(join(await placedAt(), 'manifest.json'))).toBe(true);
      expect(store.recordReceived).not.toHaveBeenCalled();
      expect(await incoming()).toEqual([]);
    });

    it('a directory the resolver refuses is left for the sweep, unassessed and with no row (#1094)', async () => {
      const refusal = new PluginDirectoryLayoutError('demo-sink', 'refused for the test');
      jest.spyOn(resolver, 'confirm').mockRejectedValue(refusal);

      await expect(byUpload()).rejects.toBe(refusal);

      expect(await exists(join(await placedAt(), 'manifest.json'))).toBe(true);
      expect(installer.assess).not.toHaveBeenCalled();
      expect(store.recordReceived).not.toHaveBeenCalled();
    });
  });

  describe('read', () => {
    it('reads a received artifact back, neither refreshing nor removing its row (#1094)', async () => {
      const received = await byUpload();
      store.findLive.mockResolvedValue(received.artifact);
      installer.assess.mockClear();

      const receipt = await receiver.read(sha256, ADMIN);

      expect(store.findLive).toHaveBeenCalledWith(sha256, expect.any(Date));
      expect(installer.assess).toHaveBeenCalledWith(received.directory);
      expect(receipt).toEqual(received);
      expect(store.refreshForInstall).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
    });

    it('takes the checksum in either case, as the post does (#1094)', async () => {
      const received = await byUpload();
      store.findLive.mockResolvedValue(received.artifact);

      const receipt = await receiver.read(` ${sha256.toUpperCase()}\t`, ADMIN);

      expect(store.findLive).toHaveBeenCalledWith(sha256, expect.any(Date));
      expect(receipt).toEqual(received);
    });

    it('checks authority before it reads anything (#1094)', async () => {
      authority.isServerAdmin.mockResolvedValue(false);

      const err = await failure(receiver.read('not a checksum', 'member-1'));

      expect(err).toBeInstanceOf(PluginInstallAuthorityError);
      expect(store.findLive).not.toHaveBeenCalled();
    });

    it.each(['not a checksum', `../../${'a'.repeat(58)}`, 'a'.repeat(63)])(
      'a value that is not a checksum, %j, answers not found without a query (#1094)',
      async (value) => {
        const err = await failure(receiver.read(value, ADMIN));

        expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
        expect(err).toMatchObject({ sha256: value });
        expect(store.findLive).not.toHaveBeenCalled();
      },
    );

    it('an artifact with no live row answers not found (#1094)', async () => {
      store.findLive.mockResolvedValue(null);

      const err = await failure(receiver.read(sha256, ADMIN));

      expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
      expect(err).toMatchObject({ sha256 });
      expect(installer.assess).not.toHaveBeenCalled();
    });

    it('an artifact whose directory is gone answers not found and keeps its row (#1094)', async () => {
      const now = new Date();
      store.findLive.mockResolvedValue(
        artifactRow(
          {
            sha256: sha256 as RecordReceivedArtifactInput['sha256'],
            slug: 'demo-sink',
            version: '1.2.0',
            compressedBytes: bytes.length,
            url: LINK,
            registrySlug: null,
            receivedById: ADMIN,
          },
          now,
        ),
      );

      const err = await failure(receiver.read(sha256, ADMIN));

      expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
      expect(installer.assess).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
    });
  });

  describe('the installed plugin a receipt reports', () => {
    it.each<[string, { version: string; uninstalledAt: Date | null } | null, PluginArtifactReceipt['installedPlugin']]>(
      [
        ['none, with no plugin row', null, { state: 'none', version: null }],
        [
          'installed, while the row is live',
          { version: '1.1.0', uninstalledAt: null },
          { state: 'installed', version: '1.1.0' },
        ],
        [
          'uninstalled, once the row is marked so',
          { version: '1.0.0', uninstalledAt: new Date('2026-11-01T00:00:00.000Z') },
          { state: 'uninstalled', version: '1.0.0' },
        ],
      ],
    )('%s (#1094)', async (_label, row, expected) => {
      db.plugin.findUnique.mockResolvedValue(row as never);

      const receipt = await byUpload();

      expect(receipt.installedPlugin).toEqual(expected);
      expect(db.plugin.findUnique).toHaveBeenCalledWith({
        where: { slug: 'demo-sink' },
        select: { version: true, uninstalledAt: true },
      });
    });

    it('is read before the row is written, so a failure to read it leaves no row (#1094)', async () => {
      const lost = new Error('connection lost');
      db.plugin.findUnique.mockRejectedValue(lost);

      await expect(byUpload()).rejects.toBe(lost);

      expect(store.recordReceived).not.toHaveBeenCalled();
    });
  });
});
