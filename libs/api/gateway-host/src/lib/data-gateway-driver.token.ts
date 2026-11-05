/**
 * The DataGatewayDriver a gateway app serves through DataGatewayController.
 * The app provides it, built with the app's own fetch, logger and version
 * (#1082).
 */
export const DATA_GATEWAY_DRIVER = Symbol('DATA_GATEWAY_DRIVER');
