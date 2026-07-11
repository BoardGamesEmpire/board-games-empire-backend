# gateway-host

Shared host layer for BGE gRPC gateway microservices (BoardGameGeek, IGDB, …).

Each gateway app was carrying byte-identical copies of the gRPC controller,
its `main.ts` bootstrap, and its bootstrap logger. This library holds the one
copy:

- **`GatewayServiceHost`** — abstract DI contract each gateway app's
  `GameGatewayService` implements. The controller depends on this abstraction,
  never on a concrete service.
- **`GameGatewayController`** — the shared gRPC controller. Logs and delegates
  every RPC to the injected `GatewayServiceHost`.
- **`createGatewayLogger(serviceName)`** — builds the base + `bootstrap`-tagged
  pino loggers a gateway app needs.
- **`bootstrapGrpcGateway(config)`** — the gRPC microservice bootstrap (proto
  walk, `createMicroservice`, logger wiring, shutdown handlers) parameterised by
  service name and host/port env keys.

A new gateway app wires up by: implementing `GatewayServiceHost`, binding it
(`{ provide: GatewayServiceHost, useClass: GameGatewayService }`), registering
`GameGatewayController`, and calling `bootstrapGrpcGateway` from its `main.ts`.

## Running unit tests

Run `nx test gateway-host` to execute the unit tests via [Jest](https://jestjs.io).
