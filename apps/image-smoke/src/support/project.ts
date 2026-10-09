/**
 * The Compose project a run takes, which names everything it leaves: what can
 * be checked of it without Docker, with its unit tests. stack.ts starts the
 * stack under it, and only the smoke suite runs that.
 */

/** The project a run takes unless BGE_SMOKE_PROJECT names another. */
const DEFAULT_PROJECT = 'bge-image-smoke';

/**
 * A project of the suite's own. A run removes its project's containers and
 * volumes before it starts, so under any other name, such as `bge`, the
 * project compose.yaml runs as, it would remove another stack's. Each name is
 * also one Compose takes for a project and Docker in an image's name, and one
 * segment of a path, so the run's files stay in the suite's output directory.
 */
const SMOKE_PROJECT = /^bge-image-smoke(-[a-z0-9-]+)?$/;

/** The project BGE_SMOKE_PROJECT names, or the suite's own when it names none. */
export function smokeProject(named: string | undefined): string {
  const project = named || DEFAULT_PROJECT;
  if (!SMOKE_PROJECT.test(project)) {
    throw new Error(
      `BGE_SMOKE_PROJECT=${project} names a project that isn't the suite's own. A run removes its project's ` +
        `containers and volumes, so it takes only ${DEFAULT_PROJECT}, or ${DEFAULT_PROJECT}- and lowercase ` +
        `letters, digits and dashes, such as ${DEFAULT_PROJECT}-2.`,
    );
  }

  return project;
}
