import { createRequire } from 'node:module';
import { parseRoles, roleBundlePath, RoleSelectionError } from './roles';

/**
 * The BGE image's entry point (#593). It reads `BGE_ROLES` and runs that role's
 * bundle in this same process, so the role's own signal handlers, telemetry and
 * exit codes are the process's, with nothing in between.
 *
 * It loads nothing but Node builtins before the role does: each role starts its
 * OpenTelemetry SDK first thing, and a module loaded ahead of that would escape
 * the auto-instrumentation.
 */
function launch(): void {
  let roles;
  try {
    roles = parseRoles(process.env['BGE_ROLES']);
  } catch (error) {
    if (!(error instanceof RoleSelectionError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  // One role per process until the all-in-one profile (#200).
  const [role] = roles;
  const bundle = roleBundlePath(role, __dirname);

  // The role then runs as `node apps/<app>/dist/main.js` would run it. Its
  // entry script is `argv[1]`, and the api's migrator looks there for the
  // `prisma.config.ts` its build ships beside the bundle.
  process.argv[1] = bundle;
  createRequire(__filename)(bundle);
}

launch();
