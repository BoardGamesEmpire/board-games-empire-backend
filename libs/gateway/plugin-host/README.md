# gateway-plugin-host

What the coordinator mounts to host the server's data-gateway plugins (#1083):
the gateway registry's plugin driver source, which builds a plugin
DataGateway's driver from the plugin the process loaded, and the controller
that serves the gateway gRPC protocol for those drivers, through which the
gateway worker reaches them.

## Running unit tests

Run `npm run nx -- test gateway-plugin-host` to execute the unit tests via [Jest](https://jestjs.io).
