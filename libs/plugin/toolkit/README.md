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
  would hold, chosen as `build` chooses them (see below) with the default
  output folder, `bge-artifacts`, so build tooling and tests the plugin
  artifact leaves out aren't screened. The archive rules are
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

1. Needs the plugin's own `package.json` and a `package-lock.json` from npm 7
   or later, and checks both before anything runs.
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
   `npm ci --omit=dev --include=prod --ignore-scripts --install-links --no-bin-links`.
   `--include=prod` keeps an `include=dev` setting in your environment or
   `.npmrc` from adding development dependencies. npm's hidden lockfile, `node_modules/.package-lock.json`, is removed: it records
   the temporary folder's path, and nothing reads it at runtime.
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
CLI's own codes. Not every server code shows up under its own name: the
server's `manifest-slug` refusal, for one, shows here as `MANIFEST_UNREADABLE`
or as a plugin manifest error, since the CLI reads the plugin manifest whole.
Messages are in English for now (#1514).

## What `build` needs, and its limits

- **A `package-lock.json`, from npm 7 or later.** `npm ci` installs exactly
  what it records, and `SOURCES.md` is read from it. Without one, `build`
  stops with `LOCKFILE_MISSING`; run `npm install` to create it. One from an
  older npm, or one that is not valid JSON, stops it with
  `LOCKFILE_UNSUPPORTED`. Both stop it before the plugin's own build runs.
- **No install scripts run.** No dependency's install script runs, so a
  dependency that needs one, such as a native addon, won't work. One built on
  the plugin author's machine wouldn't run on the server's architecture
  anyway.
- **A dependency named by a relative `file:` path can't be installed.** The
  install runs in a copy of the plugin in a temporary folder, where a path
  such as `file:../dep` leads nowhere, so `build` stops with
  `DEPENDENCY_INSTALL_FAILED`. Name the dependency by an absolute path to a
  `.tgz` made with `npm pack`, such as `file:/home/me/dep/dep-1.0.0.tgz`, then
  run `npm install` again. A folder named by an absolute path is unreliable
  even when it installs: npm records it in `package-lock.json` as a path
  counted from the plugin's folder (a link, or a copy with
  `npm install --install-links`), and the install succeeds or fails
  depending on where the temporary folder sits relative to that path, with an
  error that does not name the dependency. Pack the folder with `npm pack`
  instead.
- **A `file:` dependency's path is shipped.** The plugin artifact carries the
  plugin's own `package.json`, which keeps the path the plugin author wrote:
  an absolute path names their folders. Its `package-lock.json` keeps that
  path too, and records where npm found the dependency as a path counted from
  the plugin's folder, which still spells out every folder between the two.
  The build changes neither file, since they are what the plugin author
  declared. `SOURCES.md` shows such a dependency as `local`, and npm's hidden
  lockfile is left out. A relative path would name fewer folders, but the
  build can't install one (see above), so to ship no folder names at all,
  publish the dependency to a registry, a private one if need be, and name it
  by version.
- **The plugin's `.npmrc` is not read by the install.** npm never packs
  `.npmrc`, so the copy has none. Settings the install needs, such as a
  private registry, belong in the user or global npm configuration.
- **No credentials in a URL.** `package.json` and `package-lock.json` ship
  in the plugin artifact as written, and npm copies a dependency's URL into
  `package-lock.json` whole, user name and password included. So a URL with
  a user name or password in either file, other than the `git` user of a
  git-over-ssh URL, stops `build` before npm installs anything, and fails
  `validate` of a plugin folder
  with `URL_CREDENTIALS_REFUSED`, naming the file and where in it the first
  such URL is, never the URL itself. Give npm the credentials another way,
  such as an auth token in the `.npmrc` in your home folder or a git
  credential helper, then run `npm install` again.
- **Symbolic links.** npm leaves a plugin author's symbolic links out of its
  selection, as `npm publish` would. Only a linked `manifest.json` or
  `package-lock.json`, or a link under `node_modules` after the install,
  stops the build with `SYMLINK_REFUSED`, naming the dependency that holds
  it.
- **`SOURCES.md` is generated.** A `SOURCES.md` of the plugin's own is
  replaced in the plugin artifact.

## The plugin artifact and its checksum file

- **The plugin artifact** is `<slug>-<version>.tgz`: a gzip-compressed tar
  whose one top-level folder is `<slug>-<version>/`. One larger than the
  server's compressed-size cap (100 MiB, `PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES`
  in `@boardgamesempire/plugin-manifest`) is reported as `ARTIFACT_TOO_LARGE`
  and not written.
- **It is reproducible.** Entries are sorted by path, byte by byte. Every
  entry's time is `SOURCE_DATE_EPOCH` when it holds a whole number of seconds
  from 0 to 2147483647; any other value is ignored, and the time is 0. The
  owner is uid and gid 0 with no user or group name, files have mode 0644 and
  folders 0755, and the gzip header records no time or operating system. So
  the same files give the same bytes and the same checksum when built with
  the same Node.js and npm versions: npm decides which files are selected and
  how the dependencies are laid out, and Node.js compresses them.
- **The checksum file** is `<slug>-<version>.tgz.sha256`. It holds the
  plugin artifact's SHA-256, two spaces, its file name and a newline, the
  format `sha256sum` writes. Check it from the output folder with
  `sha256sum -c <slug>-<version>.tgz.sha256`, or
  `shasum -a 256 -c <slug>-<version>.tgz.sha256` on macOS.

## What the CLI cannot check

A report that ran every check ends with notes saying what was not checked. A
report that stopped early (an unreadable plugin manifest, a refused plugin
artifact, a usage error) carries only that error.

- **The server's permission catalog** (`NOT_CHECKED_PERMISSION_CATALOG`). A
  server checks, when the plugin is installed, that each core permission the
  plugin manifest requests exists, that none of them covers every kind of
  data, and that each one requested at household or user consent scope is
  limited to that household or user. The CLI has no permission catalog to
  check against.
- **What the scan cannot see** (`NOT_CHECKED_BEYOND_SCAN`). The scan reads
  the code for forbidden imports without running it, and no list of imports
  is a sandbox: `fetch` is a global that needs no import, a raw socket can
  carry a hand-written HTTP client (its import is only a warning), and
  `eval`-style access defeats every static check. `forbidden-specifiers.ts` in `@boardgamesempire/plugin-manifest`
  states these limits. The scan catches the ordinary ways a plugin reaches
  for the network or the database, not a plugin that hides it.

So a clean report is not a security guarantee, and the server admin installing
a plugin still decides.

## Running it from this workspace

```sh
npm run nx -- build plugin-toolkit
node libs/plugin/toolkit/dist/bin/bge-plugin.js validate path/to/plugin
node libs/plugin/toolkit/dist/bin/bge-plugin.js build path/to/plugin
```

Run these from the repository root after building. An installed copy of the
package (from npm) provides the `bge-plugin` command itself.

## Building

Run `npm run nx -- build plugin-toolkit` to build the library and its bin. The
build stamps the workspace version into the CLI as the default
`--bge-version`.

## Running unit tests

Run `npm run nx -- test plugin-toolkit` to execute the unit tests via [Jest](https://jestjs.io).
The `build` and `validate` specs run a real npm, offline, on plugins they write
under the OS temp folder.
