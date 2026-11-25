# plugin-toolkit

`bge-plugin`, the plugin author CLI: the command a plugin author runs to check
a plugin and build its plugin artifact, using the server's own checks (#1093).
It reaches the server's verdicts by running the server's own code from
`@boardgamesempire/plugin-manifest` and `@boardgamesempire/plugin-analysis`,
never a second copy of a check.

Run `bge-plugin --help` for the commands and options.

A clean report is not a security guarantee. It means the checks the CLI can
run found nothing a server would refuse. See
[What the CLI cannot check](#what-the-cli-cannot-check).

## Commands

### `bge-plugin validate <path>`

Checks a plugin as a server checks it when a server admin installs it, and
reports everything the server would refuse, everything worth a warning and
everything it could not check. `<path>` is one of:

- **A plugin folder.** The plugin is judged by the files its plugin artifact
  would hold, chosen as `build` chooses them (see below), so build tooling and
  tests the plugin artifact leaves out aren't screened. The archive rules are
  checked on the plugin's own files only; the dependencies `build` installs are
  counted when `build` checks the folder it packs. Dependencies are screened
  from `package.json` and `package-lock.json`, as the server screens them.
- **A plugin artifact (`.tgz`).** It is unpacked by the server's own
  extractor, which applies the archive rules as it goes. Like the server, it
  stops at the first refusal.

Then the checks the server runs: the plugin manifest validator, the
permissions no plugin may hold, the scan for forbidden imports and, with
`--against`, the comparison with an earlier version of the plugin.

### `bge-plugin build [path]`

Builds the plugin in `path` (the current folder when no path is given) and
writes its plugin artifact and the artifact's checksum file. In order, it:

1. Needs the plugin's own `package.json` and a `package-lock.json`.
2. Runs the plugin's own build, `npm run build --if-present`, in the plugin
   folder.
3. Chooses the plugin's files with `npm pack --dry-run --json --ignore-scripts`,
   so the `files` field and `.npmignore` steer them as they would for
   `npm publish`. `manifest.json` and `package-lock.json` are always added. The
   output folder is left out, and so is any file whose name ends in `.tgz` or
   `.tgz.sha256`, so an earlier plugin artifact is never packed again. Outside
   the output folder, each such file is reported as `PLUGIN_ARTIFACT_LEFT_OUT`:
   if the plugin needs one, rename it.
4. Copies those files into a temporary folder and installs the plugin's
   production dependencies there with
   `npm ci --omit=dev --ignore-scripts --install-links --no-bin-links`.
5. Writes `SOURCES.md` there, listing every installed dependency with its
   version, license and source.
6. Runs the server's archive rules and every check `validate` runs on that
   folder. If anything is an error, it prints the report and writes nothing.
7. Writes `<slug>-<version>.tgz` and `<slug>-<version>.tgz.sha256` into the
   output folder, creating it if needed.

The temporary folder is always removed.

## Options

| Option                    | Commands | What it does                                                                                                                                                                           |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--accept-import <name>`  | both     | Accepts one forbidden import by name, as a server admin can when installing. Repeat it for each name.                                                                                  |
| `--against <file>`        | both     | Compares with an earlier version of the plugin, given as its `manifest.json` or plugin artifact, and warns about every permission households and users would newly have to consent to. |
| `--bge-version <version>` | both     | The Board Games Empire version to check the plugin manifest's `bgeCompat` range against. Default: the version the CLI was built from.                                                  |
| `--default-locale <tag>`  | both     | The server's default language, which every translated text in the plugin manifest must include. Default: `en`.                                                                         |
| `--out-dir <folder>`      | build    | Where to write the plugin artifact. Default: `bge-artifacts` in the plugin folder.                                                                                                     |
| `--json`                  | both     | Prints the report as one JSON document: `ok`, `artifact` (when one was written), `errors`, `warnings` and `notes`. Usage errors and unexpected errors print one JSON document too.     |
| `-h`, `--help`            | both     | Shows the commands and options.                                                                                                                                                        |

`--accept-import` is the plugin author's own statement, and it binds no
server. At install the server admin decides which forbidden imports to
acknowledge, and the server refuses an acknowledgement that names an import
its scan did not find. So accept only imports the report showed: an accepted
name the scan does not find is reported as `ACCEPTED_IMPORT_NOT_FOUND`.

## Exit codes and the report

| Exit code | Meaning                                   |
| --------- | ----------------------------------------- |
| 0         | No errors. Warnings and notes may remain. |
| 1         | At least one error.                       |
| 2         | The command line was not understood.      |

Each line of the text report is `<severity> <code> <where>: <message>`, with
the severity `error`, `warning` or `note`, and a summary line at the end. The
code is stable: the server's own archive rule, plugin manifest issue code or
scan finding kind where the server reaches the same verdict, or one of the
CLI's own codes. Messages are in English for now (#1514).

## What `build` needs, and its limits

- **A `package-lock.json`, from npm 7 or later.** `npm ci` installs exactly
  what it records, and `SOURCES.md` is read from it. Without one, `build`
  stops with `LOCKFILE_MISSING`; run `npm install` to create it.
- **No install scripts run.** No dependency's install script runs, so a
  dependency that needs one, such as a native addon, won't work. One built on
  the plugin author's machine wouldn't run on the server's architecture
  anyway.
- **A dependency named by a relative `file:` path can't be installed.** The
  install runs in a copy of the plugin in a temporary folder, where a path
  such as `file:../dep` leads nowhere, so `build` stops with
  `DEPENDENCY_INSTALL_FAILED`. Name the dependency by an absolute path to a
  `.tgz` made with `npm pack`, such as `file:/home/me/dep/dep-1.0.0.tgz`, then
  run `npm install` again. A folder named by an absolute path works only when
  `package-lock.json` records it as a copy rather than a link: run
  `npm install --install-links` to record it that way.
- **A `file:` dependency's path is shipped.** npm records its path on the
  plugin author's machine in `package-lock.json`, which the plugin artifact
  carries, and `SOURCES.md` repeats it.
- **The plugin's `.npmrc` is not read by the install.** npm never packs
  `.npmrc`, so the copy has none. Settings the install needs, such as a
  private registry, belong in the user or global npm configuration.
- **Symbolic links.** npm leaves a plugin author's symbolic links out of its
  selection, as `npm publish` would. Only a linked `manifest.json` or
  `package-lock.json`, or a link under `node_modules` after the install,
  stops the build with `SYMLINK_REFUSED`, naming the dependency that holds
  it.
- **`SOURCES.md` is generated.** A `SOURCES.md` of the plugin's own is
  replaced in the plugin artifact.

## The plugin artifact and its checksum file

- **The plugin artifact** is `<slug>-<version>.tgz`: a gzip-compressed tar
  whose one top-level folder is `<slug>-<version>/`. A server accepts one of
  at most 100 MiB; a larger one is reported as `ARTIFACT_TOO_LARGE` and not
  written.
- **It is reproducible.** Entries are sorted by path, byte by byte. Every
  entry's time is `SOURCE_DATE_EPOCH` (whole seconds) when it is set, else 0.
  The owner is uid and gid 0 with no user or group name, files have mode 0644
  and folders 0755, and the gzip header records no time or operating system.
  So the same files, packed with the same Node.js version, give the same
  bytes and the same checksum, whoever builds them.
- **The checksum file** is `<slug>-<version>.tgz.sha256`. It holds the
  plugin artifact's SHA-256, two spaces, its file name and a newline, the
  format `sha256sum` writes. Check it from the output folder with
  `sha256sum -c <slug>-<version>.tgz.sha256`, or
  `shasum -a 256 -c <slug>-<version>.tgz.sha256` on macOS.

## What the CLI cannot check

Every report ends with notes saying what was not checked:

- **The server's permission catalog** (`NOT_CHECKED_PERMISSION_CATALOG`). A
  server checks, when the plugin is installed, that each core permission the
  plugin manifest requests exists, that none covers every kind of record, and
  that each one a household or a user consents to reaches only that
  household's or user's own data. The CLI has no catalog to check against.
- **What the scan cannot see** (`NOT_CHECKED_BEYOND_SCAN`). The scan reads
  the code for forbidden imports without running it, and no list of imports
  is a sandbox: `fetch` is a global that needs no import, a raw socket can
  carry a hand-written HTTP client, and `eval`-style access defeats every
  static check. `forbidden-specifiers.ts` in `@boardgamesempire/plugin-manifest`
  states these limits. The scan catches the ordinary ways a plugin reaches
  for the network or the database, not a plugin that hides it.

So a clean report is not a security guarantee, and the server admin installing
a plugin still decides.

## Running it from this workspace

```sh
npm run nx -- build plugin-toolkit
npm rebuild --ignore-scripts @boardgamesempire/plugin-toolkit
npx --no-install bge-plugin validate path/to/plugin
npx --no-install bge-plugin build path/to/plugin
```

`npm rebuild` links the `bge-plugin` bin and marks it executable: npm does
that at install only if `dist/bin/bge-plugin.js` already existed, and the
compiler writes it without the executable bit. `--no-install` keeps `npx`
from fetching an unrelated package of the same name from the npm registry.
`node libs/plugin/toolkit/dist/bin/bge-plugin.js …` runs the same build
without the link.

## Building

Run `npm run nx -- build plugin-toolkit` to build the library and its bin. The
build stamps the workspace version into the CLI as the default
`--bge-version`.

## Running unit tests

Run `npm run nx -- test plugin-toolkit` to execute the unit tests via [Jest](https://jestjs.io).
The `build` and `validate` specs run a real npm, offline, on plugins they write
under the OS temp folder.
