import baseConfig from '../../../../eslint.config.mjs';

// No i18n rule here: a driver's messages are wire text a DataGateway sends
// to the server, as the gateway apps' were (#1082).
export default [
  ...baseConfig,
  {
    ignores: ['**/out-tsc'],
  },
];
