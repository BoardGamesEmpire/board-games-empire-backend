# DataGateways pace their own upstream

DataGateways are kept as thin as they can be: each one translates between the server and one upstream and holds no state of its own. The exception is the upstream's rate limit. A DataGateway keeps one budget for its upstream and answers "throttled, retry after N" instead of calling past it. Steam was the first upstream to need this. Its store endpoints are limited per network address, and a user's search, a user-started import and the import backlog of a 650-game library sync all draw on the same budget.

The DataGateway is the only place that sees every call to its upstream. Searches come from the coordinator, or the api once #595 lands, and fetches come from any number of gateway workers. A budget anywhere else would see only part of that traffic. The decision was made in the Steam DataGateway design (#924).

- **Requests carry a traffic class,** live or background. The DataGateway keeps a reserve of its budget for live calls, so a sync's backlog can never starve a search.
- **A background call below the reserve is answered at once** with "throttled, retry after N". A live call waits only as long as its deadline allows (#722), then gets the same answer. No call is held open past its deadline.
- **The server reacts and doesn't count.** The gateway worker delays a throttled job until the retry-after time. Queue priority runs jobs a user started before background ones. Throttling never counts toward auto-disable, because a throttled DataGateway is healthy.

## Considered options

- **A fetch queue per DataGateway, with BullMQ's limiter.** BullMQ's limiter and its manual `rateLimit()` pause a whole queue, and every DataGateway's fetches share one (`QueueNames.GatewayFetch`). So this needs a queue per DataGateway, registered and torn down as DataGateways are added and removed, where Nest registers queues at module start. Per-group limits, which would avoid that, are only in BullMQ Pro, the paid edition. It also can't see live search, which never goes through a queue. Rejected.
- **A per-DataGateway budget in Redis, checked by the gateway worker.** It is shared across any number of gateway workers and keeps the DataGateway dumb. It still can't see live search, unless the coordinator and the api check it too, which spreads one upstream's limit across three processes. Rejected.

## Consequences

- The contract gains the traffic class and the throttled answer. BGG and IGDB may ignore the class, and they get the throttled answer for free the first time they need it.
- The budget lives in the DataGateway's process. Several running copies of one DataGateway would each keep their own budget. That isn't a goal. A DataGateway that rotates several upstream keys does so inside itself.
- As a plugin (#194), a DataGateway loaded by several processes would split its budget the same way. The plugin conversion has to decide where the budget lives then.
