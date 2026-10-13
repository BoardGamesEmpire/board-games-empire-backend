# Gateway coordinator

The coordinator process role. It carries live DataGateway traffic for the api over gRPC: game searches, fetching one game (or a base game's expansions), and starting imports. It listens on port 50052 in development and 50051 in production.

```
api ──gRPC──▶ coordinator ──gRPC──▶ remote DataGateways (BoardGameGeek, IGDB, …)
                   │
                   └──BullMQ──▶ import flow, run by the gateway worker and the worker
```

- **Searches** go to every connected DataGateway, or to the ones the request names, and each DataGateway's results stream back as they arrive.
- **Fetching one game** asks one DataGateway for that game's full data.
- **Starting an import** enqueues the import flow and returns the job ids at once. The coordinator fetches nothing for it: the gateway worker calls the DataGateways itself, and the worker writes the games.

It reaches DataGateways through the gateway registry (`@bge/gateway-registry`, `libs/gateway/driver/runtime`, which the gateway worker uses too). Once started, it connects every enabled DataGateway (and any enabled one it is not connected to when a call first needs it), and follows the DataGateway config changes published over Redis. The registry auto-disables a DataGateway after repeated failures: three failed connection attempts within five minutes, with no success between, switch it off.

The api, not the coordinator, keeps the DataGateway records. Admins add, change, enable and disable DataGateways through the api, which asks the coordinator to connect or disconnect them; auto-disable is the one change the registry writes itself.

## Planned

- Routing searches by what each DataGateway covers, instead of asking every connected DataGateway (#713, part of DataGateway onboarding, #709).
- Deadlines on DataGateway calls, and a circuit breaker that recovers without an admin, in front of auto-disable (#722).
- A Steam DataGateway (#651).
