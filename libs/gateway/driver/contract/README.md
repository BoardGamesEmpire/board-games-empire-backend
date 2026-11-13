# gateway-driver-contract

This library was generated with [Nx](https://nx.dev).

## Building

Run `nx build gateway-driver-contract` to build the library.

## Throttled answers and traffic classes

A DataGateway paces its own upstream (#925). When the upstream's budget is spent, it answers in-band: `RESULT_STATUS_RATE_LIMITED`, no game, and `retry_after_ms`, the milliseconds to wait before asking again. It never errors the call, so the answer works the same for a remote DataGateway and a plugin DataGateway, and it never counts as a failure. `throttledError` reads such an answer as a `DataGatewayThrottledError`.

Requests carry a traffic class. Live is a call a user is waiting on screen for, such as a search. Background is work that runs as a job, such as every import. Unset means live. A DataGateway may keep part of its budget for live calls, or ignore the class. `trafficClassOf` reads it, treating anything but background as live.

## Testing

Run `nx test gateway-driver-contract` to run its unit tests. The contract's executable form is `runDataGatewayDriverContract` in `@boardgamesempire/gateway-driver-contract-testing`; a `DataGatewayDriver` implementation proves itself by running that suite from its own spec.
