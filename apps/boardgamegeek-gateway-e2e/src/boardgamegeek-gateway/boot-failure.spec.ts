import { E2E_VERBOSE_VAR, launchChild, requireBundle, WORKSPACE_ROOT } from '@bge/testing-e2e/child-process';
import * as path from 'node:path';

const LABEL = 'BoardGameGeek gateway';
const BUNDLE = path.join(WORKSPACE_ROOT, 'apps', 'boardgamegeek-gateway', 'dist', 'main.js');

/** Long enough for the bundle to load and fail; config validation fails before anything binds. */
const BOOT_TIMEOUT_MS = 30_000;
const EXIT_POLL_MS = 250;

/**
 * A production host that sets no gRPC address and no API key. The gateway
 * has to name what is missing, the key, and not the address it has a default
 * for (#636). Empty is what the split profile passes for a key that is unset.
 */
describe('the BoardGameGeek gateway, when its API key is missing', () => {
  it.each([
    ['empty', ''],
    ['unset', undefined],
  ])(
    'names the key, not its gRPC address, and exits with code 1 (%s)',
    async (_case, apiKey) => {
      requireBundle(LABEL, BUNDLE, '@boardgamesempire/boardgamegeek-gateway:build');

      const outcome = await launchChild({
        label: LABEL,
        bundle: BUNDLE,
        // Not the workspace root, whose `.env` would supply the key.
        cwd: path.dirname(BUNDLE),
        env: {
          ...process.env,
          // The child's environment leaves out undefined values.
          BOARDGAMEGEEK_API_KEY: apiKey,
          BOARDGAMEGEEK_GATEWAY_GRPC_HOST: undefined,
          BOARDGAMEGEEK_GATEWAY_GRPC_PORT: undefined,
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
      expect(outcome.outputTail).toContainEqual(expect.stringContaining('BOARDGAMEGEEK_API_KEY'));
      expect(outcome.outputTail).not.toContainEqual(expect.stringContaining('BOARDGAMEGEEK_GATEWAY_GRPC_HOST'));
    },
    BOOT_TIMEOUT_MS * 2,
  );
});
