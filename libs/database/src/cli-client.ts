import { openStandaloneClient, type StandaloneClient } from './lib/standalone-client';

/**
 * The client the CLIs beside this file run on (`seed-cli.ts`, `plan-cli.ts`):
 * `openStandaloneClient` over `DATABASE_URL`. Each CLI loads `.env` before
 * importing this, so the variable is the developer's unless overridden.
 */
export function openCliClient(): StandaloneClient {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set. `.env` is loaded first; set the variable and run again.');
  }
  return openStandaloneClient(url);
}
