/**
 * The folder, inside the plugin's folder, that `build` writes plugin
 * artifacts into unless `--out-dir` names another. `validate` leaves it out of
 * the selection too, so it judges the files such a build would pack (#1093).
 */
export const DEFAULT_OUT_DIR = 'bge-artifacts';

export interface ValidateOptions {
  /** Forbidden imports the plugin author accepts, as a server admin can when installing. */
  readonly acceptImports: readonly string[];

  /** An earlier version of the plugin, as its manifest.json or plugin artifact, to compare consent requirements with. */
  readonly against?: string;

  readonly bgeVersion: string;
  readonly defaultLocale: string;
}

export interface BuildOptions extends ValidateOptions {
  readonly outDir: string;
}
