// Written by this project's `generate` target from the root package.json, and
// NOT committed. Nx runs `generate` before a typecheck, test or build of
// anything that imports this library, so the file exists by the time one
// compiles. `npm run nx -- run @board-games-empire/version:generate` writes it
// directly if your editor needs it sooner.
export { BGE_VERSION } from './lib/generated/bge-version';
