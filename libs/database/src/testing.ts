/**
 * Test-only entrypoint: `@bge/database/testing`.
 *
 * Kept out of `src/index.ts` so fixtures are not reachable from application code —
 * an entrypoint boundary enforces that, a comment would not. This library is the
 * wrong home for them regardless; #305 tracks extracting a leaf test library.
 */

export * from './lib/utils/prisma-error.fixtures';
