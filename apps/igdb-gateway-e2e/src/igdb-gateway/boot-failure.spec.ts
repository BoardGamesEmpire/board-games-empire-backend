import { E2E_VERBOSE_VAR, launchChild, requireBundle, WORKSPACE_ROOT } from '@bge/testing-e2e/child-process';
import { GATEWAY_NODE_ENV } from '@bge/testing-e2e/gateway';
import * as path from 'node:path';
import { useTokenEndpoint } from '../support/token-endpoint';

const LABEL = 'IGDB gateway';
const BUNDLE = path.join(WORKSPACE_ROOT, 'apps', 'igdb-gateway', 'dist', 'main.js');

/** Long enough for the bundle to load and fail, on its config or on its first failed token request. */
const BOOT_TIMEOUT_MS = 30_000;
const EXIT_POLL_MS = 250;

/**
 * A gateway that cannot boot has to say so in its exit code: a supervisor
 * restarts or alerts on a non-zero exit, and takes exit 0 as a clean stop.
 * The IGDB gateway fetches its Twitch token while it boots, so a token
 * endpoint that answers with an error fails the boot from inside the shared
 * gRPC bootstrap, the path that used to exit 0 (#630).
 */
describe('the IGDB gateway, when its boot fails', () => {
  const tokenEndpoint = useTokenEndpoint({ failWith: 503 });

  it(
    'logs the failure and exits with code 1',
    async () => {
      requireBundle(LABEL, BUNDLE, '@boardgamesempire/igdb-gateway:build');

      const outcome = await launchChild({
        label: LABEL,
        bundle: BUNDLE,
        env: {
          ...process.env,
          // Valid placeholders, so the boot gets past config validation to the
          // token request.
          IGDB_CLIENT_ID: 'e2e-client-id',
          IGDB_CLIENT_SECRET: 'e2e-client-secret',
          IGDB_TOKEN_URL: tokenEndpoint.url(),
          // The boot fails before the gateway binds; port 0 keeps a regression
          // that gets that far off every fixed port.
          IGDB_GATEWAY_GRPC_HOST: '127.0.0.1',
          IGDB_GATEWAY_GRPC_PORT: '0',
          NODE_ENV: GATEWAY_NODE_ENV,
        },
        verbose: process.env[E2E_VERBOSE_VAR] === 'true',
        // Never ready: the only passing outcome is an exit during boot.
        isReady: async () => false,
        timeoutMs: BOOT_TIMEOUT_MS,
        pollMs: EXIT_POLL_MS,
      });

      expect(outcome.kind).toBe('exited');
      expect(outcome.child.exitCode).toBe(1);
      expect(outcome.outputTail).toContainEqual(expect.stringContaining('bootstrap failed'));

      // The failure is the token request, not some other boot error that
      // exits 1 by another route, such as a config validation failure.
      expect(outcome.outputTail).toContainEqual(
        expect.stringContaining('Failed to obtain IGDB access token: 503 Service Unavailable'),
      );
    },
    BOOT_TIMEOUT_MS * 2,
  );
});

/**
 * A production host that sets no gRPC address and no client credentials. The
 * gateway has to name what is missing, a credential, and not the address it
 * has a default for (#636). Empty is what the split profile passes for a
 * credential that is unset.
 */
describe('the IGDB gateway, when its client credentials are missing', () => {
  it.each([
    ['empty', ''],
    ['unset', undefined],
  ])(
    'names the client id, not its gRPC address, and exits with code 1 (%s)',
    async (_case, credential) => {
      requireBundle(LABEL, BUNDLE, '@boardgamesempire/igdb-gateway:build');

      const outcome = await launchChild({
        label: LABEL,
        bundle: BUNDLE,
        // Not the workspace root, whose `.env` would supply the credentials.
        cwd: path.dirname(BUNDLE),
        env: {
          ...process.env,
          // The child's environment leaves out undefined values.
          IGDB_CLIENT_ID: credential,
          IGDB_CLIENT_SECRET: credential,
          IGDB_GATEWAY_GRPC_HOST: undefined,
          IGDB_GATEWAY_GRPC_PORT: undefined,
          NODE_ENV: 'production',
        },
        verbose: process.env[E2E_VERBOSE_VAR] === 'true',
        // Never ready: the only passing outcome is an exit during boot.
        isReady: async () => false,
        timeoutMs: BOOT_TIMEOUT_MS,
        pollMs: EXIT_POLL_MS,
      });

      expect(outcome.kind).toBe('exited');
      expect(outcome.child.exitCode).toBe(1);
      // Validation stops at the first failure, and the client id comes first.
      expect(outcome.outputTail).toContainEqual(expect.stringContaining('IGDB_CLIENT_ID'));
      expect(outcome.outputTail).not.toContainEqual(expect.stringContaining('IGDB_GATEWAY_GRPC_HOST'));
    },
    BOOT_TIMEOUT_MS * 2,
  );
});
