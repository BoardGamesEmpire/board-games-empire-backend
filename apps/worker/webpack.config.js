const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: [
        './src/assets',
        // i18n catalogs from @bge/i18n. The bundled I18nModule resolves its
        // loader path as `join(__dirname, 'i18n')` (dist dir at runtime), so
        // the en/*.json catalogs must be copied to dist/i18n. Mirrors the
        // copy in apps/api; the module itself is wired into this app in #146.
        {
          glob: '**/*.json',
          input: '../../libs/common/i18n/src/lib/i18n',
          output: 'i18n',
        },
      ],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
