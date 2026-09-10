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
        {
          glob: '**/*.proto',
          input: '../../libs/proto/gateway/proto-export',
          output: 'proto',
        },
        // i18n catalogs from @bge/i18n. The bundled I18nModule resolves its
        // loader path as `join(__dirname, 'i18n')` (dist dir at runtime), so
        // the en/*.json catalogs must be copied to dist/i18n. Mirrors the
        // .proto copy above.
        {
          glob: '**/*.json',
          input: '../../libs/common/i18n/src/lib/i18n',
          output: 'i18n',
        },
        // The migrator (#236): `prisma migrate deploy` runs as a child
        // process from the bundle's directory, so the schema, the migration
        // chain and the config that points at them ship beside main.js. The
        // `prisma` CLI itself is a runtime dependency in package.json.
        {
          glob: '**/*',
          input: '../../prisma/migrations',
          output: 'prisma/migrations',
        },
        {
          glob: '**/*.prisma',
          input: '../../prisma/models',
          output: 'prisma/models',
        },
        {
          glob: 'schema.prisma',
          input: '../../prisma',
          output: 'prisma',
        },
        {
          glob: 'prisma.config.ts',
          input: '../..',
          output: '.',
        },
      ],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
