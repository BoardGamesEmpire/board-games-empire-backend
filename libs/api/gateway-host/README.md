# gateway-host

Shared host layer for BGE gRPC gateway microservices (BoardGameGeek, IGDB, …).

Each gateway app was carrying byte-identical copies of the gRPC controller,
its `main.ts` bootstrap, and its bootstrap logger. This library holds the one
copy:

- **`DATA_GATEWAY_DRIVER`** — the token a gateway app provides its
  `DataGatewayDriver` under. The driver holds all upstream-specific behavior
  (#1082); the BoardGameGeek and IGDB drivers live in
  `@bge/gateway-driver-boardgamegeek` and `@bge/gateway-driver-igdb`, where a
  plugin DataGateway can load them too.
- **`DataGatewayController`** — the shared gRPC controller. Logs every RPC and
  hands it to the driver. A driver's error that carries a gRPC status code
  (`unsupportedOperation` gives UNIMPLEMENTED) goes out as that status. It
  disposes of the driver when the app shuts down.
- **`createDriverLogger(context)`** and **`nodeUpstreamFetch`** — the logger
  and the `UpstreamFetch` an app hands its driver: Nest's `Logger`, and Node's
  `fetch`.
- **`createGatewayLogger(serviceName)`** — builds the base + `bootstrap`-tagged
  pino loggers a gateway app needs.
- **`bootstrapGrpcGateway(config)`** — the gRPC microservice bootstrap (proto
  walk, `createMicroservice`, logger wiring, shutdown handlers) parameterised by
  service name and the app's address config, which it reads once the app's
  config is validated.

A new gateway app wires up by: providing its driver
(`{ provide: DATA_GATEWAY_DRIVER, useFactory: … }`), registering
`DataGatewayController`, and calling `bootstrapGrpcGateway` from its `main.ts`.

## Running unit tests

Run `nx test gateway-host` to execute the unit tests via [Jest](https://jestjs.io).
