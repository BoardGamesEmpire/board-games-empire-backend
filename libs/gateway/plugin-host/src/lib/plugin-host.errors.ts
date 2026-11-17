/**
 * A loaded data-gateway plugin gave the server no driver it can use (#1083):
 * what the plugin loaded with is no driver factory, or its driver factory
 * returned something that isn't a driver.
 *
 * The gateway registry counts it as a failed connect, toward auto-disable of
 * the plugin's DataGateway, and an auto-disable keeps the last error's
 * message for the server admins' notification. So the message is written for
 * a server admin: it names the plugin by its slug, and says who can fix it.
 */
export class PluginDataGatewayBuildError extends Error {
  override readonly name = 'PluginDataGatewayBuildError';

  constructor(public readonly slug: string) {
    super(
      `Plugin '${slug}' did not provide a DataGateway driver the server can use. ` +
        'The fault is in the plugin: look for an update to it, or report this to the plugin author.',
    );
  }
}

/**
 * A loaded data-gateway plugin's driver factory had handed over nothing by
 * the time the server stopped waiting for it (#1083). Whether it would have
 * provided a driver is not known, so this is an error of its own: the other
 * one's message would not be true of it.
 *
 * It is a failed build like any other to the gateway registry, a failed
 * connect counted toward auto-disable, and its message can reach the server
 * admins the same way. A driver may be slow to start because its upstream
 * is, which the plugin author can't fix, so the message names that first.
 */
export class PluginDataGatewayBuildTimeoutError extends Error {
  override readonly name = 'PluginDataGatewayBuildTimeoutError';

  constructor(
    public readonly slug: string,
    public readonly waitedMs: number,
  ) {
    super(
      `Plugin '${slug}' took too long to start its DataGateway driver: the server waited ${waitedMs / 1_000} seconds. ` +
        'Check that its upstream can be reached, or report this to the plugin author.',
    );
  }
}
