# Plugin DataGateways run in the coordinator

A plugin DataGateway runs in the coordinator and nowhere else, as one copy that keeps one budget for its upstream. The gateway worker loads no plugin: it reaches a plugin DataGateway through the coordinator, over the gateway gRPC protocol, the way it reaches a remote DataGateway. The api no longer loads data-gateway plugins.

A DataGateway keeps one budget for its upstream ([ADR 0003](0003-datagateways-pace-their-own-upstream.md)), and the budget holds only while one copy of the DataGateway sees every call. Before this, the api was the only process that loaded plugins, and DataGateway calls were routed only in the coordinator and the gateway worker. The decision was made when the plugin conversion was planned (#194; the decisions recorded there on 2026-11-05) and carried out in #1083.

- **Each process names the plugin categories it loads.** The coordinator loads data-gateway plugins at start, one copy each, and the api loads every other category.
- **The coordinator serves the gateway gRPC protocol for its plugin DataGateways** on the port it already listens on, beside its own protocol. Each call names its DataGateway and its actor in the call's metadata.
- **A data-gateway plugin's factory returns a driver factory, not a driver,** so the coordinator can build a new driver after one is disposed or fails its first interview, without a restart.
- **Everything of the plugin's that a driver runs, it runs as the plugin actor,** acting for the whole server and lent no authority by whoever set the call going. The plugin reaches its upstream through its plugin context's HTTP client, held to the outbound domains its plugin manifest declares.
- **Whether a plugin is loaded is read from the plugin load records.** A record names the install a process loaded and says whether the load completed. The gateway worker routes a plugin DataGateway only while a running coordinator's record names the plugin's current install. The api reads the same records to tell whether switching a data-gateway plugin on needs a restart.

## Considered options

- **Loading them in both the coordinator and the gateway worker.** Its best argument was no extra network hop. It means two copies, two budgets, and the loader's writes to a plugin, marking its load failed or a restart required, from three processes. Rejected.
- **The gateway worker only.** It is the process role that scales out, so the copies multiply, each with its own budget. Rejected.
- **A dedicated plugin-host process role.** Its main benefit, keeping a plugin that hangs or crashes away from the coordinator's other work, comes from the separate-process execution mode (#197), run in the coordinator. Separate scaling isn't a goal for self-hosting. Set aside; see below.
- **Containers the server starts, one per plugin.** They need the Docker socket or an orchestrator credential, which is root on the machine. Every orchestrator differs. The outbound HTTP policy stops applying to code that opens its own sockets. Plugins ship as plugin artifacts, not images, and running containers would become the server's job. An operator who wants a DataGateway in its own container can already run its official image as a remote DataGateway. Rejected.

## Still open

A dedicated process role for plugin DataGateways may become worth having for a hosted service, where separate scaling can matter. The gateway worker already reaches plugin DataGateways over gRPC, and the hosting code is a lib (`libs/gateway/plugin-host`) a second app can import, so moving them into their own process role later is a deployment change, not a redesign.

## Consequences

- A data-gateway plugin's install, reinstall or update takes effect when the coordinator restarts. An install or a reinstall leaves the plugin switched off, so its DataGateway is refused as not served. Once an admin switches the plugin on, which reports that a restart is required, the DataGateway is refused as not loaded, with a reason that says to restart the coordinator, until the coordinator restarts and loads it. After an update the old code keeps serving until that restart. Switching the plugin off or uninstalling it stops its DataGateway being routed at once, because routing reads the plugin's state from the database.
- With one coordinator, a plugin DataGateway keeps one budget for every caller in every process. Several coordinators would each keep their own, as ADR 0003 says of any DataGateway run as several copies.
- The coordinator mounts the plugins volume and only reads it. The api still writes plugin directories and sweeps the ones nothing needs.
- The coordinator runs third-party code. A plugin is held to its plugin actor's consented authority and to its declared outbound domains, but until the separate-process execution mode runs it apart, a plugin that hangs or crashes shares the coordinator's process.
- While the coordinator is down or restarting, the gateway worker can't reach a plugin DataGateway. A coordinator that shuts down cleanly deletes its load records, so the gateway worker refuses the DataGateway as not loaded rather than dialling an address nothing answers at, and a refusal never counts toward auto-disable. Calls in flight when the coordinator stops fail and count toward auto-disable, as they do for a remote DataGateway that restarts. A coordinator that dies leaves its load records fresh for up to five minutes. Until they go stale, the gateway worker still dials it, and each failed call counts toward auto-disable, as it does for a remote DataGateway that is down.
- The coordinator imports the whole plugin module, so it carries install, update and consent code it never runs. Splitting a loader core out of it is a refactor with no change in behaviour, left for later.
