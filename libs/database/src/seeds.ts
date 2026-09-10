/**
 * Seed entrypoint: `@bge/database/seeds`.
 *
 * Kept out of `src/index.ts` so the seed set, and the `@bge/locale` data the
 * languages seed carries, load only where seeding happens: the boot
 * sequence's seeds phase (`@bge/bootstrap`) and the `prisma db seed` wrapper
 * (`prisma/seed.ts`). Every app imports the main barrel; none of them seeds
 * through it.
 */

export * from './lib/seeds';
