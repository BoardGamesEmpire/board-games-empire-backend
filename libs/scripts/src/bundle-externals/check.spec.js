'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkBundleExternals } = require('./check');

/** A webpack bundle's external, as `NxAppWebpackPlugin` emits it. */
const external = (specifier) => `/***/ ((module) => {\n\nmodule.exports = require("${specifier}");\n\n/***/ }),\n`;

describe('checkBundleExternals', () => {
  let root;

  /** Writes `content` at `relative` under the throwaway root, creating its directories. */
  function write(relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  function installPackage(relativeDir, manifest = {}) {
    write(path.join(relativeDir, 'package.json'), JSON.stringify({ main: 'index.js', ...manifest }));
    write(path.join(relativeDir, 'index.js'), 'module.exports = {};\n');
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-bundle-externals-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes a bundle whose externals all resolve where it runs', () => {
    installPackage('node_modules/dep');
    const bundle = write('apps/api/dist/main.js', external('dep') + external('node:path') + external('path'));

    expect(checkBundleExternals([bundle])).toEqual({ externals: 3, missing: [], withoutExternals: [] });
  });

  it('names the bundle and the external that does not resolve', () => {
    installPackage('node_modules/dep');
    const bundle = write('apps/api/dist/main.js', external('dep') + external('dev-only'));

    expect(checkBundleExternals([bundle]).missing).toEqual([{ bundle, specifier: 'dev-only' }]);
  });

  it("resolves a subpath through the package's exports, as require does", () => {
    installPackage('node_modules/dep', { exports: { '.': './index.js', './runtime': './index.js' } });
    const bundle = write('apps/api/dist/main.js', external('dep/runtime') + external('dep/internal'));

    expect(checkBundleExternals([bundle]).missing).toEqual([{ bundle, specifier: 'dep/internal' }]);
  });

  it("finds a package installed under one app's own node_modules for that app only", () => {
    installPackage('apps/worker/node_modules/nested');
    const worker = write('apps/worker/dist/main.js', external('nested'));
    const api = write('apps/api/dist/main.js', external('nested'));

    expect(checkBundleExternals([worker, api]).missing).toEqual([{ bundle: api, specifier: 'nested' }]);
  });

  it('counts only externals, not other text that mentions require', () => {
    installPackage('node_modules/dep');
    const bundle = write(
      'apps/api/dist/main.js',
      external('dep') + '// see require("left-pad") in the docs\nconst x = "module.exports = require(\\"nope\\")";\n',
    );

    expect(checkBundleExternals([bundle])).toEqual({ externals: 1, missing: [], withoutExternals: [] });
  });

  it('names a bundle in which it finds no externals, which it cannot vouch for', () => {
    installPackage('node_modules/dep');
    const checked = write('apps/api/dist/main.js', external('dep'));
    const unreadable = write('apps/worker/dist/main.js', 'module.exports = require("dep")["named"];\n');

    expect(checkBundleExternals([checked, unreadable]).withoutExternals).toEqual([unreadable]);
  });
});
