/**
 * Stands in for `@jest/globals` when the fixture plugin is bundled. The
 * package the in-memory driver ships in also exports the driver contract
 * suite, which imports Jest's globals, and `@jest/globals` throws when it is
 * imported outside a Jest run, as a plugin the coordinator loads is. The
 * plugin calls none of these.
 *
 * Each export here is one that package imports. esbuild fails the build on
 * an import this file doesn't export, which is the cue to add it.
 */
const outsideJest = (): never => {
  throw new Error("The fixture plugin runs outside Jest: the driver contract suite can't run inside a plugin");
};

export const afterEach = outsideJest;
export const beforeEach = outsideJest;
export const describe = outsideJest;
export const expect = outsideJest;
export const it = outsideJest;
