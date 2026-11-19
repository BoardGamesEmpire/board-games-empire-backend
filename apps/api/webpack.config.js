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
        // i18n catalogs from @bge/i18n-core. The bundled I18nModule loads them from
        // `I18N_CATALOG_DIR`, `join(__dirname, 'i18n')` (dist dir at runtime), so
        // the en/*.json catalogs must be copied to dist/i18n. Mirrors the
        // .proto copy above.
        {
          glob: '**/*.json',
          input: '../../libs/common/i18n-core/src/lib/i18n',
          output: 'i18n',
        },
        // The standard privacy policy from @bge/i18n-core, one Markdown file per
        // language, read at boot from `PRIVACY_POLICY_DIR`,
        // `join(__dirname, 'privacy-policy')`. The directory is the policy's
        // alone, so an operator can mount their own files over it without
        // hiding anything else (#934). Only the api serves the policy.
        {
          glob: '**/*.md',
          input: '../../libs/common/i18n-core/src/lib/privacy-policy',
          output: 'privacy-policy',
        },
        // The migrator (#236): `prisma migrate deploy` runs as a child
        // process from the bundle's directory, so the datasource
        // (`schema.prisma`), the migration chain and the config that points at
        // them ship beside main.js. The models stay behind: `migrate deploy`
        // applies the chain and never reads them (#452). The `prisma` CLI
        // itself is a runtime dependency in package.json.
        {
          glob: '**/*',
          input: '../../prisma/migrations',
          output: 'prisma/migrations',
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
